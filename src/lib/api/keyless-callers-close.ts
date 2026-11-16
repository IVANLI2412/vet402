import { sql } from "drizzle-orm";
import { utcWeekStart } from "@/lib/api/keyless-week";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { rowsOf } from "@/lib/settlements/upsert";

export type CloseKeylessWeeksResult = { closed: string[] };

/** Close completed ISO weeks (idempotent daily cron). */
export async function closeCompletedKeylessWeeks(now: Date = new Date()): Promise<CloseKeylessWeeksResult> {
  const db = getDb();
  if (!db) return { closed: [] };
  const currentWeek = utcWeekStart(now);
  const closed: string[] = [];

  let candidates: { week_start: string }[] = [];
  try {
    candidates = rowsOf<{ week_start: string }>(
      await db.execute(
        sql`SELECT DISTINCT week_start::text AS week_start
            FROM (
              SELECT week_start FROM keyless_caller_days
              UNION
              SELECT week_start FROM keyless_week_salts
              UNION
              SELECT week_start FROM keyless_carry_bits
            ) weeks
            WHERE week_start < ${currentWeek}::date
            ORDER BY week_start`,
      ),
    );
  } catch (error) {
    if (isMissingSchemaError(error)) return { closed: [] };
    throw error;
  }

  for (const { week_start: weekStart } of candidates) {
    const exists = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT 1::int AS n FROM keyless_caller_weekly WHERE week_start = ${weekStart}::date LIMIT 1`,
      ),
    );
    const weeklyClosed = exists.length > 0;

    if (!weeklyClosed) {
      const row = rowsOf<{
        callers: number;
        callers_2plus_days: number;
        returning_wow: number;
      }>(
        await db.execute(sql`
          SELECT
            (SELECT count(DISTINCT caller_hash)::int FROM keyless_caller_days WHERE week_start = ${weekStart}::date) AS callers,
            (SELECT count(*)::int FROM (
               SELECT caller_hash FROM keyless_caller_days
               WHERE week_start = ${weekStart}::date
               GROUP BY caller_hash HAVING count(DISTINCT day) >= 2
             ) s) AS callers_2plus_days,
            (SELECT count(DISTINCT caller_hash)::int FROM keyless_caller_days
             WHERE week_start = ${weekStart}::date AND is_returning = true) AS returning_wow
        `),
      )[0];
      if (!row) continue;

      await db.execute(
        sql`INSERT INTO keyless_caller_weekly (week_start, callers, callers_2plus_days, returning_wow, closed_at)
            VALUES (${weekStart}::date, ${row.callers}::int, ${row.callers_2plus_days}::int, ${row.returning_wow}::int, now())
            ON CONFLICT (week_start) DO NOTHING`,
      );
    }

    await db.execute(sql`DELETE FROM keyless_caller_days WHERE week_start = ${weekStart}::date`);
    await db.execute(sql`DELETE FROM keyless_carry_bits WHERE week_start = ${weekStart}::date`);
    await db.execute(sql`DELETE FROM keyless_week_salts WHERE week_start = ${weekStart}::date`);

    if (!weeklyClosed) closed.push(weekStart);
  }

  return { closed };
}