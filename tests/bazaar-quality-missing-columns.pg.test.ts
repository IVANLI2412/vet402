// 2026-11-15 第2波 index: scripts/sql/2026-11-15-bazaar-quality-observed.sql を当てる前の本番（2 列が無い DB）でも、
// Bazaar の目録の同期は既存の列を書いて通り、警告は 1 行。売り手の読み取りは null（頁は節を隠す）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("bazaar quality missing columns (skipped)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("without the two columns, Bazaar sync still writes the existing columns and warns once", async (t) => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { syncCatalog, upsertCatalogCursorPage } = await import("@/lib/observatory/catalog-sync");
    const { __resetBazaarQualityWarningForTests } = await import("@/lib/observatory/catalog-bazaar-quality");
    const { readHostCalledVsDelivered } = await import("@/lib/sellers/called-vs-delivered");
    const db = getDb()!;
    await db.execute(sql`ALTER TABLE x402_endpoints DROP COLUMN IF EXISTS quality_observed_at`);
    await db.execute(sql`ALTER TABLE x402_endpoints DROP COLUMN IF EXISTS bazaar_curated`);
    t.after(async () => {
      await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
      await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean`);
    });
    __resetBazaarQualityWarningForTests();
    const warnings: string[] = [];
    t.mock.method(console, "warn", (line: unknown) => {
      warnings.push(String(line));
    });

    const accept = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xa", payTo: "0x2222222222222222222222222222222222222222" };
    const key = "nocols.test/v1";
    const item = parseCatalogItem({
      resource: `https://${key}`,
      curated: true,
      quality: { l30DaysTotalCalls: 41, l30DaysUniquePayers: 7 },
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const summary = await syncCatalog({
      fetchResult: { items: [item], totalCount: 1, fetchedCount: 1, complete: true },
      today: "2026-11-15",
      source: "cdp_bazaar",
    });
    assert.equal(summary.skipped, 0);
    const row = await db.execute(
      sql`SELECT quality_calls_30d, quality_payers_30d, status FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const r = (Array.isArray(row) ? row : (row as { rows: unknown[] }).rows)[0] as {
      quality_calls_30d: number;
      quality_payers_30d: number;
      status: string;
    };
    assert.equal(Number(r.quality_calls_30d), 41);
    assert.equal(Number(r.quality_payers_30d), 7);
    assert.equal(r.status, "active");

    // カーソルの経路も同じく通る（既存の列は更新される）。
    const cursorKey = "nocols.test/v2";
    const cursorItem = parseCatalogItem({
      resource: `https://${cursorKey}`,
      quality: { l30DaysTotalCalls: 9 },
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const page = await upsertCatalogCursorPage([cursorItem], {
      now: new Date("2026-11-15T12:00:00.000Z"),
      passSeq: 1,
      circle: { keys: new Set<string>(), latestComplete: true, absenceProven: false },
    });
    assert.equal(page.skipped, 0);
    const crow = await db.execute(
      sql`SELECT quality_calls_30d FROM x402_endpoints WHERE resource_key = ${cursorKey} AND source = 'cdp_bazaar'`,
    );
    const cr = (Array.isArray(crow) ? crow : (crow as { rows: unknown[] }).rows)[0] as { quality_calls_30d: number };
    assert.equal(Number(cr.quality_calls_30d), 9);

    // 警告は 1 行だけ（2 回の書き込みで 1 回）。
    const ours = warnings.filter((w) => w.includes("quality_observed_at"));
    assert.equal(ours.length, 1);

    // 売り手の読み取りは null（頁は節を隠す）で、投げない。
    const read = await readHostCalledVsDelivered(db, "nocols.test");
    assert.equal(read, null);
  });
}
