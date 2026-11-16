// H-1 keyless caller weekly counts — TEST_DATABASE_URL required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

test("keyless caller tables keep no IP or UA columns", () => {
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  const sqlFile = readFileSync(
    join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
    "utf8",
  );
  for (const forbidden of ["ip_addr", "user_agent", "referer_path"]) {
    assert.equal(schema.includes(forbidden), false, `schema must not store ${forbidden}`);
    assert.equal(sqlFile.includes(forbidden), false, `sql must not store ${forbidden}`);
  }
  assert.match(schema, /keylessCallerDays/);
  assert.match(sqlFile, /keyless_caller_days/);
  assert.doesNotMatch(sqlFile, /RENAME COLUMN/);
});

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("keyless callers (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("weekly close deletes rows and salts", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { setAfterResponseSchedulerForTest } = await import("@/lib/util/after-response");
    const { recordKeylessCallerVisit } = await import("@/lib/api/keyless-callers");
    const { closeCompletedKeylessWeeks } = await import("@/lib/api/keyless-callers-close");
    const { utcWeekStart, addUtcWeeks } = await import("@/lib/api/keyless-week");

    const db = getDb()!;
    const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(
      sql`TRUNCATE keyless_week_salts, keyless_caller_days, keyless_carry_bits, keyless_caller_weekly RESTART IDENTITY`,
    );

    const pending: Array<() => Promise<void>> = [];
    setAfterResponseSchedulerForTest((task) => pending.push(task));

    const now = new Date("2026-11-10T12:00:00.000Z");
    const week = utcWeekStart(now);
    await recordKeylessCallerVisit("203.0.113.1", "vet402-sdk/1.0.0", now);
    await recordKeylessCallerVisit("203.0.113.1", "vet402-sdk/1.0.0", now);
    while (pending.length) await pending.shift()!();

    const dayRows = await db.execute(
      sql`SELECT count(*)::int AS n FROM keyless_caller_days WHERE week_start = ${week}::date`,
    );
    const rows = (raw: unknown) =>
      [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { n: number }[])];
    assert.equal(rows(dayRows)[0]?.n, 1, "same caller same day is one row");

    const fakeNow = new Date(`${addUtcWeeks(week, 1)}T01:00:00.000Z`);
    const closed = await closeCompletedKeylessWeeks(fakeNow);
    assert.ok(closed.closed.includes(week));

    const salts = rows(
      await db.execute(sql`SELECT count(*)::int AS n FROM keyless_week_salts WHERE week_start = ${week}::date`),
    )[0]?.n;
    assert.equal(salts, 0, "closed week salt removed");

    const daysLeft = rows(
      await db.execute(sql`SELECT count(*)::int AS n FROM keyless_caller_days WHERE week_start = ${week}::date`),
    )[0]?.n;
    assert.equal(daysLeft, 0, "closed week day rows removed");
  });

  test("returning callers match prior-week bloom carry", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { setAfterResponseSchedulerForTest } = await import("@/lib/util/after-response");
    const { recordKeylessCallerVisit } = await import("@/lib/api/keyless-callers");
    const { utcWeekStart, addUtcWeeks } = await import("@/lib/api/keyless-week");

    const db = getDb()!;
  const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(
      sql`TRUNCATE keyless_week_salts, keyless_caller_days, keyless_carry_bits, keyless_caller_weekly RESTART IDENTITY`,
    );

    const pending: Array<() => Promise<void>> = [];
    setAfterResponseSchedulerForTest((task) => pending.push(task));

    const ip = "198.51.100.9";
    const ua = "vet402-sdk/1.0.0";
    const week1 = utcWeekStart(new Date("2026-11-10T12:00:00.000Z"));
    await recordKeylessCallerVisit(ip, ua, new Date("2026-11-10T12:00:00.000Z"));
    while (pending.length) await pending.shift()!();

    const week2 = addUtcWeeks(week1, 1);
    await recordKeylessCallerVisit(ip, ua, new Date(`${week2}T12:00:00.000Z`));
    while (pending.length) await pending.shift()!();

    const returningRow = rowsOf<{ is_returning: boolean }>(
      await db.execute(
        sql`SELECT is_returning FROM keyless_caller_days
            WHERE week_start = ${week2}::date AND is_returning = true`,
      ),
    );
    assert.equal(returningRow.length, 1, "prior-week bloom marks returning caller");

    await recordKeylessCallerVisit("203.0.113.88", "other-client/1.0", new Date(`${week2}T15:00:00.000Z`));
    while (pending.length) await pending.shift()!();
    const freshOnly = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM keyless_caller_days
            WHERE week_start = ${week2}::date AND is_returning = true`,
      ),
    );
    assert.equal(freshOnly[0]?.n, 1, "caller without carry bits stays not returning");
  });

  test("returning caller after prior week is closed", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { setAfterResponseSchedulerForTest } = await import("@/lib/util/after-response");
    const { recordKeylessCallerVisit } = await import("@/lib/api/keyless-callers");
    const { closeCompletedKeylessWeeks } = await import("@/lib/api/keyless-callers-close");
    const { utcWeekStart, addUtcWeeks } = await import("@/lib/api/keyless-week");

    const db = getDb()!;
    const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(
      sql`TRUNCATE keyless_week_salts, keyless_caller_days, keyless_carry_bits, keyless_caller_weekly RESTART IDENTITY`,
    );

    const pending: Array<() => Promise<void>> = [];
    setAfterResponseSchedulerForTest((task) => pending.push(task));

    const ip = "198.51.100.77";
    const ua = "vet402-sdk/1.0.0";
    const week1 = utcWeekStart(new Date("2026-11-10T12:00:00.000Z"));
    await recordKeylessCallerVisit(ip, ua, new Date("2026-11-10T12:00:00.000Z"));
    while (pending.length) await pending.shift()!();

    const week2 = addUtcWeeks(week1, 1);
    await closeCompletedKeylessWeeks(new Date(`${week2}T01:00:00.000Z`));

    await recordKeylessCallerVisit(ip, ua, new Date(`${week2}T12:00:00.000Z`));
    while (pending.length) await pending.shift()!();

    const returning = rowsOf<{ is_returning: boolean }>(
      await db.execute(
        sql`SELECT is_returning FROM keyless_caller_days
            WHERE week_start = ${week2}::date AND is_returning = true`,
      ),
    );
    assert.equal(returning.length, 1, "carry bits survive week close");

    const weekly = rowsOf<{ callers: number }>(
      await db.execute(sql`SELECT callers::int FROM keyless_caller_weekly WHERE week_start = ${week1}::date`),
    );
    assert.equal(weekly[0]?.callers, 1);
  });

  test("stats keep ended week before cron close rolls it up", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { setAfterResponseSchedulerForTest } = await import("@/lib/util/after-response");
    const { recordKeylessCallerVisit, readKeylessCallerStats } = await import("@/lib/api/keyless-callers");
    const { utcWeekStart, addUtcWeeks } = await import("@/lib/api/keyless-week");

    const db = getDb()!;
    const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(
      sql`TRUNCATE keyless_week_salts, keyless_caller_days, keyless_carry_bits, keyless_caller_weekly RESTART IDENTITY`,
    );

    const pending: Array<() => Promise<void>> = [];
    setAfterResponseSchedulerForTest((task) => pending.push(task));

    const currentWeek = utcWeekStart();
    const endedWeekStart = addUtcWeeks(currentWeek, -1);
    await recordKeylessCallerVisit(
      "203.0.113.22",
      "vet402-sdk/1.0.0",
      new Date(`${endedWeekStart}T12:00:00.000Z`),
    );
    while (pending.length) await pending.shift()!();

    const stats = await readKeylessCallerStats();
    const endedWeek = stats.weeks.find((w) => w.week_start === endedWeekStart);
    assert.ok(endedWeek, "ended week stays in stats before weekly close");
    assert.equal(endedWeek.keyless_callers_7d, 1);
    assert.equal(endedWeek.in_progress, undefined);
  });

  test("close removes orphan week salts with no caller days", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { recordKeylessCallerVisit } = await import("@/lib/api/keyless-callers");
    const { closeCompletedKeylessWeeks } = await import("@/lib/api/keyless-callers-close");
    const { utcWeekStart, addUtcWeeks } = await import("@/lib/api/keyless-week");

    const db = getDb()!;
    const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(
      sql`TRUNCATE keyless_week_salts, keyless_caller_days, keyless_carry_bits, keyless_caller_weekly RESTART IDENTITY`,
    );

    const week = utcWeekStart(new Date("2026-11-10T12:00:00.000Z"));
    await recordKeylessCallerVisit("203.0.113.1", "vet402-sdk/1.0.0", new Date("2026-11-10T12:00:00.000Z"));

    const nextWeekStart = addUtcWeeks(week, 1);
    const closeAt = new Date(`${addUtcWeeks(week, 2)}T01:00:00.000Z`);
    await closeCompletedKeylessWeeks(closeAt);

    const saltsLeft = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM keyless_week_salts WHERE week_start <= ${week}::date`),
    )[0]?.n;
    assert.equal(saltsLeft, 0);

    const orphanSalts = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM keyless_week_salts WHERE week_start = ${nextWeekStart}::date`,
      ),
    )[0]?.n;
    assert.equal(orphanSalts, 0, "next-week salt from carry setup is removed when that week ends");
  });
}

function rowsOf<T>(raw: unknown): T[] {
  return [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];
}