import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("snapshot-only catalogs (skipped)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("recordSnapshotOnlyCatalog does not overwrite complete with failure", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { recordSnapshotOnlyCatalog } = await import("@/lib/observatory/snapshot-only-catalogs");
    const db = getDb()!;
    const day = "2026-11-15";
    await recordSnapshotOnlyCatalog(
      db,
      "rail402_discovery",
      { items: [], totalCount: 28, fetchedCount: 28, complete: true },
      day,
    );
    await recordSnapshotOnlyCatalog(db, "rail402_discovery", null, day);
    const row = await db.execute(
      sql`SELECT total_count, fetched_count, complete FROM x402_catalog_snapshots WHERE source = 'rail402_discovery' AND snapshot_date = ${day}`,
    );
    const r = (Array.isArray(row) ? row : (row as { rows: unknown[] }).rows)[0] as { total_count: number; complete: boolean };
    assert.equal(Number(r.total_count), 28);
    assert.equal(r.complete, true);
  });

  test("recordSnapshotOnlyCatalog writes empty failed snapshot on another day", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { recordSnapshotOnlyCatalog } = await import("@/lib/observatory/snapshot-only-catalogs");
    const db = getDb()!;
    const day = "2026-11-14";
    await recordSnapshotOnlyCatalog(db, "payai_discovery", null, day);
    const row = await db.execute(
      sql`SELECT total_count, fetched_count, complete, resource_keys FROM x402_catalog_snapshots WHERE source = 'payai_discovery' AND snapshot_date = ${day}`,
    );
    const r = (Array.isArray(row) ? row : (row as { rows: unknown[] }).rows)[0] as {
      total_count: number;
      fetched_count: number;
      complete: boolean;
      resource_keys: string[];
    };
    assert.equal(Number(r.total_count), 0);
    assert.equal(Number(r.fetched_count), 0);
    assert.equal(r.complete, false);
    assert.deepEqual(r.resource_keys, []);
  });
}