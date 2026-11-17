// ============================================================
// ERC-8004 の購入の読み取り（feedback JSON・weekly・Attest）を実 DB で固定する（2026-11-17）。
// 本番で feedback と weekly が 503 だった: SQL が存在しない列 pu.l2_detail・pu.l2_body_head・
// pu.l2_content_type を読んでいた（材料は raw_response_meta の中）。ここは本物の表に当てて通すこと。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("erc8004 purchase reads (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("erc8004 purchase reads run on the real purchases table", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { readPurchaseForErc8004Feedback, readPurchasesForErc8004AgentWeek } = await import(
      "@/lib/observatory/erc8004-purchase-match"
    );
    const db = getDb()!;
    const rowsOf = <T,>(raw: unknown) => (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as T[];
    const wallet = "0xfeed000000000000000000000000000000000001";

    await db.execute(sql`TRUNCATE x402_l1_purchases, owner_agents, agents, x402_endpoints CASCADE`);
    const ep = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network)
        VALUES ('feedback-test', 'https://example.test/x', 'GET', 'base') RETURNING id::text AS id
      `),
    )[0]!.id;
    await db.execute(sql`INSERT INTO agents (agent_id, chain_id, wallet) VALUES (42, 8453, ${wallet})`);
    const pid = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, pay_to, payer, tx_hash, http_status_paid, payload_non_empty, l2_schema, raw_response_meta, attempted_at)
        VALUES (${ep}::uuid, 'settled', ${wallet}, '0xpayer', '0xabc', 200, true, 'mismatch',
                '{"l2": {"reason": "x"}, "bodyHead": "hello", "contentType": "application/json"}'::jsonb, '2026-11-10T00:00:00Z')
        RETURNING id::text AS id
      `),
    )[0]!.id;

    const one = await readPurchaseForErc8004Feedback(db, pid);
    assert.ok(one);
    assert.equal(one!.erc8004_agent, "eip155:8453:42");
    assert.equal(one!.erc8004_match_kind, "agent_wallet");
    assert.equal(one!.l2_body_head, "hello");
    assert.equal(one!.l2_content_type, "application/json");
    assert.deepEqual(one!.l2_detail, { reason: "x" });

    const week = await readPurchasesForErc8004AgentWeek(
      db,
      42n,
      8453,
      new Date("2026-11-09T00:00:00Z"),
      new Date("2026-11-16T00:00:00Z"),
    );
    assert.equal(week.length, 1);
    assert.equal(week[0]!.id, pid);
  });
}
