// 2026-11-16 第2波 index: 本番の neon-http は引数を型なしの文字列で送る。postgres-js の型推定に頼ると通る SQL が、本番では
// 42804（argument of CASE/WHEN must be type boolean, not type text）で落ちた。ここでは drizzle の SQL を文字列の引数だけで流す
// 偽の db を作り、生の SQL が型なしの引数でも通ることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("untyped params (skipped)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  /**
   * neon-http と同じく、引数を型の指定なしの文字列として送る db。postgres-js に引数を渡すと、サーバが推した型で直列化し直す
   * （真偽は true の値でないと 'f' になる）ので、本番と違う。ここでは各 $n を型の無い文字列の定数（'...'）に置き換えて
   * 単純な問い合わせで流す。型の無い定数は、型の無い引数と同じくサーバが文脈から型を決める（VALUES の中は text になる）。
   */
  async function untypedDb() {
    const postgres = (await import("postgres")).default;
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const dialect = new PgDialect();
    const client = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
    const literal = (p: unknown): string => {
      if (p === null || p === undefined) return "NULL";
      const text = typeof p === "object" ? JSON.stringify(p) : String(p);
      return `'${text.replaceAll("'", "''")}'`;
    };
    return {
      client,
      db: {
        async execute(query: import("drizzle-orm").SQL) {
          const q = dialect.sqlToQuery(query);
          const text = q.sql.replace(/\$(\d+)/g, (_, n: string) => literal(q.params[Number(n) - 1]));
          return client.unsafe(text);
        },
      },
    };
  }

  test("writeBazaarQualityMeta works with untyped params and skips with one warning when columns are missing", async (t) => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { writeBazaarQualityMeta, __resetBazaarQualityWarningForTests } = await import("@/lib/observatory/catalog-bazaar-quality");
    const db = getDb()!;
    const { client, db: untyped } = await untypedDb();
    t.after(async () => {
      await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
      await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean`);
      await client.end();
    });
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean`);
    const key = "untyped.test/v1";
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, status)
      VALUES (${key}, ${`https://${key}`}, 'cdp_bazaar', 'active')
      ON CONFLICT DO NOTHING`);
    const item = parseCatalogItem({
      resource: `https://${key}`,
      curated: true,
      quality: { l30DaysTotalCalls: 5 },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1", asset: "0xa", payTo: "0x4444444444444444444444444444444444444444" }],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    });
    const at = new Date("2026-11-16T01:00:00.000Z");
    const warnings: string[] = [];
    __resetBazaarQualityWarningForTests();
    const written = await writeBazaarQualityMeta(untyped, [item], at, (l) => warnings.push(l));
    assert.equal(written.status, "written");
    const row = await db.execute(
      sql`SELECT quality_observed_at, bazaar_curated FROM x402_endpoints WHERE resource_key = ${key} AND source = 'cdp_bazaar'`,
    );
    const r = (Array.isArray(row) ? row : (row as { rows: unknown[] }).rows)[0] as { quality_observed_at: unknown; bazaar_curated: boolean };
    assert.equal(new Date(String(r.quality_observed_at)).toISOString(), at.toISOString());
    assert.equal(r.bazaar_curated, true);
    assert.equal(warnings.length, 0);

    // 列が無い DB: 42703 として飛ばし、警告は 1 行（2 回呼んでも 1 行）。
    await db.execute(sql`ALTER TABLE x402_endpoints DROP COLUMN IF EXISTS quality_observed_at`);
    await db.execute(sql`ALTER TABLE x402_endpoints DROP COLUMN IF EXISTS bazaar_curated`);
    const a = await writeBazaarQualityMeta(untyped, [item], at, (l) => warnings.push(l));
    const b = await writeBazaarQualityMeta(untyped, [item], at, (l) => warnings.push(l));
    assert.equal(a.status, "skipped_missing_columns");
    assert.equal(b.status, "skipped_missing_columns");
    assert.equal(warnings.length, 1);
  });

  test("snapshot-only, seller and settlement-index raw SQL accept untyped params", async (t) => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { recordSnapshotOnlyCatalog } = await import("@/lib/observatory/snapshot-only-catalogs");
    const { readHostCalledVsDelivered } = await import("@/lib/sellers/called-vs-delivered");
    const db = getDb()!;
    const { client, db: untyped } = await untypedDb();
    t.after(async () => {
      await client.end();
    });
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean`);
    await recordSnapshotOnlyCatalog(
      untyped as never,
      "rail402_discovery",
      { items: [], totalCount: 3, fetchedCount: 3, complete: true },
      "2026-11-16",
    );
    await recordSnapshotOnlyCatalog(untyped as never, "rail402_discovery", null, "2026-11-16");
    const snap = await db.execute(
      sql`SELECT total_count, complete FROM x402_catalog_snapshots WHERE source = 'rail402_discovery' AND snapshot_date = '2026-11-16'`,
    );
    const s = (Array.isArray(snap) ? snap : (snap as { rows: unknown[] }).rows)[0] as { total_count: number; complete: boolean };
    assert.equal(Number(s.total_count), 3);
    assert.equal(s.complete, true);
    const read = await readHostCalledVsDelivered(untyped as never, "untyped-host.test");
    assert.ok(read);
    assert.equal(read.vet402.settled, 0);

    const { readSettlementIndexStatus } = await import("@/lib/observatory/settlement-index-status");
    const index = await readSettlementIndexStatus(untyped);
    assert.equal(index.status, "ok");
  });
}
