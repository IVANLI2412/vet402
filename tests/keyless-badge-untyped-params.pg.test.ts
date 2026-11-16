// 2026-11-16 wave2: keyless callers と badge fetch の生 SQL を型なし引数で流す。
//
// なぜ: 本番の neon-http は引数を型の無い文字列として送る。postgres-js の試験は型付きで送るので、
// 文脈から型を決められない $n があると本番で 42804 / 42883 に落ちる。ここでは db.execute を
// PREPARE（引数の型を指定しない）＋ EXECUTE（引数は型の無い文字列の定数）に差し替え、型付き経路と同じ結果になることを固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { __setDbForTests } from "@/lib/db/client";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("keyless badge untyped params (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  let seq = 0;

  function literal(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    const s =
      typeof v === "string"
        ? v
        : v instanceof Date
          ? v.toISOString()
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
    return `'${s.replace(/'/g, "''")}'`;
  }

  /** db.execute だけ PREPARE / EXECUTE（型なし文字列引数）に差し替えた写し。 */
  async function untypedExecuteDb() {
    const { getDb } = await import("@/lib/db/client");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const dialect = new PgDialect();
    const execute = async (q: Parameters<typeof db.execute>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(q as never);
      if (params.length === 0) return db.execute(sql.raw(text));
      const name = `kb_untyped_${++seq}`;
      await db.execute(sql.raw(`PREPARE ${name} AS ${text}`));
      try {
        return await db.execute(sql.raw(`EXECUTE ${name}(${params.map(literal).join(", ")})`));
      } finally {
        await db.execute(sql.raw(`DEALLOCATE ${name}`));
      }
    };
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") return execute;
        return Reflect.get(target, prop, receiver);
      },
    });
    return proxy as typeof db;
  }

  async function applyMigrationAndTruncate() {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(
      sql`TRUNCATE keyless_week_salts, keyless_caller_days, keyless_carry_bits, keyless_caller_weekly, badge_fetch_daily RESTART IDENTITY`,
    );
  }

  after(() => {
    __setDbForTests(null);
  });

  test("recordKeylessCallerVisit と readKeylessCallerStats は型なし引数でも型付きと同じ", async () => {
    const { recordKeylessCallerVisit, readKeylessCallerStats } = await import("@/lib/api/keyless-callers");
    const { utcWeekStart } = await import("@/lib/api/keyless-week");

    const ip = "203.0.113.44";
    const ua = "vet402-untyped/1.0.0";
    const now = new Date("2026-11-10T12:00:00.000Z");
    const week = utcWeekStart(now);

    await applyMigrationAndTruncate();
    __setDbForTests(null);
    await recordKeylessCallerVisit(ip, ua, now);
    await recordKeylessCallerVisit(ip, ua, now);
    const typedStats = await readKeylessCallerStats();
    const typedWeek = typedStats.weeks.find((w) => w.week_start === week);
    assert.ok(typedWeek);
    assert.equal(typedWeek.keyless_callers_7d, 1);

    await applyMigrationAndTruncate();
    __setDbForTests(await untypedExecuteDb());
    try {
      await recordKeylessCallerVisit(ip, ua, now);
      await recordKeylessCallerVisit(ip, ua, now);
      const untypedStats = await readKeylessCallerStats();
      const untypedWeek = untypedStats.weeks.find((w) => w.week_start === week);
      assert.ok(untypedWeek);
      assert.deepEqual(untypedWeek, typedWeek);
      assert.deepEqual(untypedStats.weeks.filter((w) => w.week_start === week), typedStats.weeks.filter((w) => w.week_start === week));
    } finally {
      __setDbForTests(null);
    }
  });

  test("closeCompletedKeylessWeeks は型なし引数でも型付きと同じ", async () => {
    const { recordKeylessCallerVisit } = await import("@/lib/api/keyless-callers");
    const { closeCompletedKeylessWeeks } = await import("@/lib/api/keyless-callers-close");
    const { utcWeekStart, addUtcWeeks } = await import("@/lib/api/keyless-week");
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");

    const ip = "198.51.100.55";
    const ua = "vet402-untyped/1.0.0";
    const now = new Date("2026-11-10T12:00:00.000Z");
    const week = utcWeekStart(now);
    const closeAt = new Date(`${addUtcWeeks(week, 2)}T01:00:00.000Z`);

    await applyMigrationAndTruncate();
    __setDbForTests(null);
    await recordKeylessCallerVisit(ip, ua, now);
    const typedClosed = await closeCompletedKeylessWeeks(closeAt);
    assert.ok(typedClosed.closed.includes(week));

    const db = getDb()!;
    const typedWeekly = await db.execute(
      sql`SELECT callers::int, callers_2plus_days::int, returning_wow::int FROM keyless_caller_weekly WHERE week_start = ${week}::date`,
    );
    const typedRow = rowsOf<{ callers: number; callers_2plus_days: number; returning_wow: number }>(typedWeekly)[0];
    assert.ok(typedRow);
    assert.equal(typedRow.callers, 1);

    await applyMigrationAndTruncate();
    __setDbForTests(await untypedExecuteDb());
    try {
      await recordKeylessCallerVisit(ip, ua, now);
      const untypedClosed = await closeCompletedKeylessWeeks(closeAt);
      assert.deepEqual(untypedClosed, typedClosed);

      const untypedWeekly = await db.execute(
        sql`SELECT callers::int, callers_2plus_days::int, returning_wow::int FROM keyless_caller_weekly WHERE week_start = ${week}::date`,
      );
      const untypedRow = rowsOf<{ callers: number; callers_2plus_days: number; returning_wow: number }>(untypedWeekly)[0];
      assert.deepEqual(untypedRow, typedRow);
    } finally {
      __setDbForTests(null);
    }
  });

  test("upsertBadgeFetch と readBadgeFetches は型なし引数でも型付きと同じ", async () => {
    const { upsertBadgeFetch, readBadgeFetches } = await import("@/lib/badge/fetch-stats");
    const fixed = new Date("2026-11-10T15:00:00.000Z");

    await applyMigrationAndTruncate();
    __setDbForTests(null);
    await upsertBadgeFetch("https://untyped-badge.example/a", "host", fixed);
    await upsertBadgeFetch("https://untyped-badge.example/b?q=1", "endpoint", fixed);
    const typed = await readBadgeFetches(7);

    await applyMigrationAndTruncate();
    __setDbForTests(await untypedExecuteDb());
    try {
      await upsertBadgeFetch("https://untyped-badge.example/a", "host", fixed);
      await upsertBadgeFetch("https://untyped-badge.example/b?q=1", "endpoint", fixed);
      const untyped = await readBadgeFetches(7);
      assert.deepEqual(untyped, typed);
    } finally {
      __setDbForTests(null);
    }
  });
}

function rowsOf<T>(raw: unknown): T[] {
  return [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];
}