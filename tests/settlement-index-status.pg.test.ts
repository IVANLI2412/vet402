import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement index db (skipped)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("readSettlementIndexStatus counts chain_index only in 30d window", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { readSettlementIndexStatus } = await import("@/lib/observatory/settlement-index-status");
    const db = getDb()!;
    const chain = "eip155:8453";
    const txInWindow = "0x" + "wave2in".padEnd(64, "0");
    const txOther = "0x" + "wave2other".padEnd(64, "1");
    const txOld = "0x" + "wave2old".padEnd(64, "2");
    await db.execute(sql`
      DELETE FROM settlements WHERE tx_hash IN (${txInWindow}, ${txOther}, ${txOld})`);
    const beforeRaw = await db.execute(sql`
      SELECT count(*)::int AS n FROM settlements
      WHERE chain = ${chain} AND source = 'chain_index'
        AND coalesce(block_time, observed_at) >= now() - interval '30 days'`);
    const beforeRows = (Array.isArray(beforeRaw) ? beforeRaw : ((beforeRaw as { rows?: unknown[] }).rows ?? [])) as {
      n: number;
    }[];
    const before = Number(beforeRows[0]?.n ?? 0);
    await db.execute(sql`
      INSERT INTO indexer_checkpoints (scope, last_block, updated_at) VALUES ('settlements:eip155:8453', 0, now())
      ON CONFLICT (scope) DO UPDATE SET updated_at = now()`);
    await db.execute(sql`
      INSERT INTO settlements (chain, tx_hash, purchase_id, source, block_time, observed_at, amount, attribution)
      VALUES (${chain}, ${txInWindow}, ${chain + ":" + txInWindow}, 'chain_index', now(), now(), '1', 'unmatched'),
             (${chain}, ${txOther}, ${chain + ":" + txOther}, 'other', now(), now(), '1', 'unmatched'),
             (${chain}, ${txOld}, ${chain + ":" + txOld}, 'chain_index', now() - interval '40 days', now() - interval '40 days', '1', 'unmatched')`);
    const summary = await readSettlementIndexStatus();
    assert.equal(summary.status, "ok");
    if (summary.status !== "ok") return;
    const base = summary.byChain.find((r) => r.chain === chain);
    assert.equal((base?.settlements30d ?? 0) - before, 1);
  });
}