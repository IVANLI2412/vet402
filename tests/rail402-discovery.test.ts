import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("rail402 discovery (skipped)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("syncRail402Discovery records 28 items from fetchImpl", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { syncRail402Discovery } = await import("@/lib/observatory/snapshot-only-catalogs");
    const items = Array.from({ length: 28 }, (_, i) =>
      parseCatalogItem({
        resource: `https://stellar.example/item-${i}`,
        accepts: [{ scheme: "exact", network: "stellar:pubnet", payTo: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: "1", asset: "USDC" }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      }),
    );
    const summary = await syncRail402Discovery({
      today: "2026-11-15",
      fetchCatalog: async () => ({ items, totalCount: 28, fetchedCount: 28, complete: true }),
    });
    assert.equal(summary.fetchedCount, 28);
    const db = getDb()!;
    const row = await db.execute(
      sql`SELECT fetched_count, complete FROM x402_catalog_snapshots WHERE source = 'rail402_discovery' AND snapshot_date = '2026-11-15'`,
    );
    const r = (Array.isArray(row) ? row : (row as { rows: unknown[] }).rows)[0] as { fetched_count: number; complete: boolean };
    assert.equal(Number(r.fetched_count), 28);
    assert.equal(r.complete, true);
    // 件数の写しだけ: 測る母集団（x402_endpoints）には 1 行も入れない。
    const eps = await db.execute(
      sql`SELECT count(*)::int AS n FROM x402_endpoints WHERE source = 'rail402_discovery' OR resource_key LIKE 'stellar.example/item-%'`,
    );
    const n = Number(((Array.isArray(eps) ? eps : (eps as { rows: unknown[] }).rows)[0] as { n: number }).n);
    assert.equal(n, 0);
  });
}