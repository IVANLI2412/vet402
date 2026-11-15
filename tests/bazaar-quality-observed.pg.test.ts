import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("bazaar quality observed (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const accept = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x2222222222222222222222222222222222222222",
  };

  test("Bazaar sync sets quality_observed_at and Circle sync does not clear it", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const db = getDb()!;
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean`);
    const key = "with-quality.test/v1";
    const withQuality = parseCatalogItem({
      resource: `https://${key}`,
      quality: { l30DaysTotalCalls: 5 },
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const noQuality = parseCatalogItem({
      resource: `https://${key}`,
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const pack = (items: ReturnType<typeof parseCatalogItem>[]) => ({
      items,
      totalCount: items.length,
      fetchedCount: items.length,
      complete: true,
    });
    await syncCatalog({ fetchResult: pack([withQuality]), today: "2026-11-15", source: "cdp_bazaar" });
    const afterFirst = await db.execute(
      sql`SELECT quality_observed_at, quality_calls_30d, bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const row1 = (Array.isArray(afterFirst) ? afterFirst : (afterFirst as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      quality_calls_30d: number;
      bazaar_curated: boolean;
    };
    assert.ok(row1.quality_observed_at);
    assert.equal(Number(row1.quality_calls_30d), 5);
    assert.equal(row1.bazaar_curated, false);

    const curatedKey = "curated.test/v1";
    const curated = parseCatalogItem({
      resource: `https://${curatedKey}`,
      curated: true,
      quality: { l30DaysTotalCalls: 1 },
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    await syncCatalog({ fetchResult: pack([curated]), today: "2026-11-15", source: "cdp_bazaar" });
    const curatedRow = await db.execute(
      sql`SELECT bazaar_curated FROM x402_endpoints WHERE resource_key = ${curatedKey} AND source = 'cdp_bazaar'`,
    );
    const cr = (Array.isArray(curatedRow) ? curatedRow : (curatedRow as { rows: unknown[] }).rows)[0] as {
      bazaar_curated: boolean;
    };
    assert.equal(cr.bazaar_curated, true);

    await syncCatalog({ fetchResult: pack([noQuality]), today: "2026-11-16", source: "cdp_bazaar" });
    const afterSecond = await db.execute(
      sql`SELECT quality_observed_at, quality_calls_30d, bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const row2 = (Array.isArray(afterSecond) ? afterSecond : (afterSecond as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      quality_calls_30d: number | null;
      bazaar_curated: boolean;
    };
    assert.equal(
      new Date(String(row2.quality_observed_at)).toISOString(),
      new Date(String(row1.quality_observed_at)).toISOString(),
    );
    assert.equal(row2.bazaar_curated, false);
    const circleItem = parseCatalogItem({
      resource: `https://${key}`,
      metadata: { method: "GET" },
      accepts: [accept],
    });
    const obsBefore = new Date(String(row2.quality_observed_at)).toISOString();
    await syncCatalog({ fetchResult: pack([circleItem]), today: "2026-11-17", source: "circle_discovery" });
    const afterCircle = await db.execute(
      sql`SELECT quality_observed_at, bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const kept = (Array.isArray(afterCircle) ? afterCircle : (afterCircle as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      bazaar_curated: boolean | null;
    };
    assert.equal(new Date(String(kept.quality_observed_at)).toISOString(), obsBefore);
    assert.equal(kept.bazaar_curated, false);
  });

  test("upsertCatalogCursorPage sets quality_observed_at and keeps prior when quality is absent", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { upsertCatalogCursorPage, syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const db = getDb()!;
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean`);
    const key = "cursor-quality.test/v1";
    const circleKey = "cursor-circle-shared.test/v1";
    await db.execute(sql`DELETE FROM x402_endpoints WHERE resource_key IN (${key}, ${circleKey})`);
    const circleCtx = { keys: new Set<string>(), latestComplete: false, absenceProven: true };
    const withQuality = parseCatalogItem({
      resource: `https://${key}`,
      quality: { l30DaysTotalCalls: 3 },
      curated: true,
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const atFirst = new Date("2026-11-15T10:00:00.000Z");
    await upsertCatalogCursorPage([withQuality], { now: atFirst, passSeq: 1, circle: circleCtx });
    const afterQuality = await db.execute(
      sql`SELECT quality_observed_at, bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const q1 = (Array.isArray(afterQuality) ? afterQuality : (afterQuality as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      bazaar_curated: boolean;
    };
    assert.equal(new Date(String(q1.quality_observed_at)).toISOString(), atFirst.toISOString());
    assert.equal(q1.bazaar_curated, true);

    const noQuality = parseCatalogItem({
      resource: `https://${key}`,
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const atSecond = new Date("2026-11-16T10:00:00.000Z");
    await upsertCatalogCursorPage([noQuality], { now: atSecond, passSeq: 2, circle: circleCtx });
    const afterNoQuality = await db.execute(
      sql`SELECT quality_observed_at, bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const q2 = (Array.isArray(afterNoQuality) ? afterNoQuality : (afterNoQuality as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      bazaar_curated: boolean;
    };
    assert.equal(new Date(String(q2.quality_observed_at)).toISOString(), atFirst.toISOString());
    // curated の無い Bazaar の項目は false（一度 true でも戻る）。
    assert.equal(q2.bazaar_curated, false);

    // 列を足した直後の本番の行（bazaar_curated が NULL）も、curated の無い Bazaar の同期で false になる。
    await db.execute(sql`UPDATE x402_endpoints SET bazaar_curated = NULL WHERE resource_key = ${key} AND source = 'cdp_bazaar'`);
    await upsertCatalogCursorPage([noQuality], { now: atSecond, passSeq: 3, circle: circleCtx });
    const fromNull = await db.execute(
      sql`SELECT bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const qn = (Array.isArray(fromNull) ? fromNull : (fromNull as { rows: unknown[] }).rows)[0] as { bazaar_curated: boolean | null };
    assert.equal(qn.bazaar_curated, false);

    const bazaarShared = parseCatalogItem({
      resource: `https://${circleKey}`,
      quality: { l30DaysTotalCalls: 2, l30DaysUniquePayers: 4 },
      curated: true,
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    await upsertCatalogCursorPage([bazaarShared], { now: atFirst, passSeq: 1, circle: circleCtx });
    const circleOnly = parseCatalogItem({
      resource: `https://${circleKey}`,
      metadata: { method: "GET" },
      accepts: [accept],
    });
    await syncCatalog({
      fetchResult: { items: [circleOnly], totalCount: 1, fetchedCount: 1, complete: true },
      today: "2026-11-15",
      source: "circle_discovery",
    });
    // Circle の同期は Bazaar の 2 列を消さない。
    const afterCircleSync = await db.execute(
      sql`SELECT quality_observed_at, bazaar_curated FROM x402_endpoints WHERE resource_key = ${circleKey} AND source = 'cdp_bazaar'`,
    );
    const keptByCircle = (Array.isArray(afterCircleSync) ? afterCircleSync : (afterCircleSync as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      bazaar_curated: boolean;
    };
    assert.equal(new Date(String(keptByCircle.quality_observed_at)).toISOString(), atFirst.toISOString());
    assert.equal(keptByCircle.bazaar_curated, true);
    const noQualityCircleKey = parseCatalogItem({
      resource: `https://${circleKey}`,
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    await upsertCatalogCursorPage([noQualityCircleKey], {
      now: atSecond,
      passSeq: 3,
      circle: { keys: new Set([circleKey]), latestComplete: true, absenceProven: false },
    });
    const afterCircleCursor = await db.execute(
      sql`SELECT quality_observed_at, bazaar_curated FROM x402_endpoints WHERE resource_key = ${circleKey} AND source = 'cdp_bazaar'`,
    );
    const shared = (Array.isArray(afterCircleCursor) ? afterCircleCursor : (afterCircleCursor as { rows: unknown[] }).rows)[0] as {
      quality_observed_at: Date;
      bazaar_curated: boolean;
    };
    assert.equal(new Date(String(shared.quality_observed_at)).toISOString(), atFirst.toISOString());
    // curated の無い Bazaar の項目が来たら false（Bazaar の今の値を写す）。
    assert.equal(shared.bazaar_curated, false);
  });
}