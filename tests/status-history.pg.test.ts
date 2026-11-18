// ============================================================
// getStatusHistory against the real schema: bounded read, same answers.
// Run: TEST_DATABASE_URL=... npm run test:db -- tests/status-history.pg.test.ts
// ============================================================
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

test("status history reads the window, not the whole table", () => {
  const source = readFileSync("src/lib/health/snapshot.ts", "utf8");
  const history = source.slice(source.indexOf("export async function getStatusHistory"));
  assert.match(history, /\.where\(gte\(healthSnapshots\.checkedAt, cutoff\)\)/);
  assert.equal((history.match(/\.limit\(1\)/g) ?? []).length, 2);
});

if (!TEST_DB) {
  test("status history SQL (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const DAY = 24 * 60 * 60 * 1000;

  async function reset() {
    const { getDb } = await import("@/lib/db/client");
    const { healthSnapshots } = await import("@/lib/db/schema");
    const db = getDb()!;
    await db.delete(healthSnapshots);
    return { db, healthSnapshots };
  }

  beforeEach(reset);

  test("status history: rows outside the window ground monitoringSince but are not counted", async () => {
    const { db, healthSnapshots } = await reset();
    const { getStatusHistory } = await import("@/lib/health/snapshot");
    const now = Date.now();
    const first = new Date(now - 90 * DAY);
    const latest = new Date(now - 60_000);
    await db.insert(healthSnapshots).values([
      { checkedAt: first, status: "error" },
      { checkedAt: new Date(now - 31 * DAY), status: "degraded", detail: "payee=degraded" },
      { checkedAt: new Date(now - 2 * DAY), status: "degraded", detail: "payee=degraded" },
      { checkedAt: latest, status: "ok" },
    ]);

    const h = await getStatusHistory(30);
    assert.equal(h.unreadable, undefined);
    assert.equal(h.monitoringSince?.getTime(), first.getTime());
    assert.equal(h.current?.status, "ok");
    assert.equal(h.current?.checkedAt.getTime(), latest.getTime());
    assert.equal(h.days.reduce((n, d) => n + d.total, 0), 2);
    assert.equal(h.days.reduce((n, d) => n + d.error, 0), 0);
    assert.deepEqual(h.days.find((d) => d.degraded === 1)?.causes, ["payee lookup slow"]);
  });

  test("status history: an empty window still reports the last row, so the page can say stale", async () => {
    const { db, healthSnapshots } = await reset();
    const { currentVerdict, getStatusHistory } = await import("@/lib/health/snapshot");
    const last = new Date(Date.now() - 40 * DAY);
    await db.insert(healthSnapshots).values({ checkedAt: last, status: "ok" });

    const h = await getStatusHistory(30);
    assert.deepEqual(h.days, []);
    assert.equal(h.current?.checkedAt.getTime(), last.getTime());
    assert.equal(h.monitoringSince?.getTime(), last.getTime());
    assert.equal(currentVerdict(h, new Date()).kind, "stale");
  });

  test("status history: an empty table is none, not ok", async () => {
    const { currentVerdict, getStatusHistory } = await import("@/lib/health/snapshot");
    const h = await getStatusHistory(30);
    assert.equal(h.current, null);
    assert.equal(h.monitoringSince, null);
    assert.equal(currentVerdict(h, new Date()).kind, "none");
  });
}
