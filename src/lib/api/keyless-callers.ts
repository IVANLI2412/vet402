import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getClientIp } from "@/lib/api/client-ip";
import { addUtcWeeks, utcDay, utcWeekStart } from "@/lib/api/keyless-week";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { rowsOf } from "@/lib/settlements/upsert";
import { runAfterResponse } from "@/lib/util/after-response";
import { logAndSwallowSafe } from "@/lib/util/log-safe";

const BLOOM_M = 1 << 20;
const BLOOM_K = 4;

export type KeylessUsageRoute = "rest:check" | "rest:decision";

function saltBytesFromHex(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function callerDigest(saltHex: string, ip: string, userAgent: string): Buffer {
  return createHash("sha256")
    .update(saltBytesFromHex(saltHex))
    .update(ip)
    .update("\n")
    .update(userAgent)
    .digest();
}

export function callerHashHex(saltHex: string, ip: string, userAgent: string): string {
  return callerDigest(saltHex, ip, userAgent).toString("hex");
}

export function bloomBits(digest: Buffer): number[] {
  const bits: number[] = [];
  for (let i = 0; i < BLOOM_K; i++) {
    bits.push(digest.readUInt32BE((i * 4) % 28) % BLOOM_M);
  }
  return bits;
}

async function ensureWeekSalt(db: NonNullable<ReturnType<typeof getDb>>, weekStart: string): Promise<string | null> {
  const rows = rowsOf<{ salt: string }>(
    await db.execute(sql`SELECT salt FROM keyless_week_salts WHERE week_start = ${weekStart}::date`),
  );
  const hit = rows[0]?.salt;
  if (hit) return hit;
  const salt = randomBytes(32).toString("hex");
  await db.execute(
    sql`INSERT INTO keyless_week_salts (week_start, salt)
        VALUES (${weekStart}::date, ${salt}::text)
        ON CONFLICT (week_start) DO NOTHING`,
  );
  const again = rowsOf<{ salt: string }>(
    await db.execute(sql`SELECT salt FROM keyless_week_salts WHERE week_start = ${weekStart}::date`),
  );
  return again[0]?.salt ?? null;
}

async function carryBitsPresent(db: NonNullable<ReturnType<typeof getDb>>, weekStart: string, bits: number[]): Promise<boolean> {
  if (bits.length === 0) return false;
  const needed = [...new Set(bits)];
  const rows = rowsOf<{ bit: number }>(
    await db.execute(
      sql`SELECT bit FROM keyless_carry_bits
          WHERE week_start = ${weekStart}::date
            AND bit IN (${sql.join(needed.map((b) => sql`${b}::int`), sql`, `)})`,
    ),
  );
  const have = new Set(rows.map((r) => r.bit));
  return needed.every((b) => have.has(b));
}

async function insertCarryBits(
  db: NonNullable<ReturnType<typeof getDb>>,
  weekStart: string,
  bits: number[],
): Promise<void> {
  for (const bit of bits) {
    await db.execute(
      sql`INSERT INTO keyless_carry_bits (week_start, bit)
          VALUES (${weekStart}::date, ${bit}::int)
          ON CONFLICT DO NOTHING`,
    );
  }
}

async function upsertCallerDay(
  db: NonNullable<ReturnType<typeof getDb>>,
  weekStart: string,
  callerHash: string,
  day: string,
  isReturning: boolean,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO keyless_caller_days (week_start, caller_hash, day, is_returning)
        VALUES (${weekStart}::date, ${callerHash}::text, ${day}::date, ${isReturning}::boolean)
        ON CONFLICT (week_start, caller_hash, day)
        DO UPDATE SET is_returning = keyless_caller_days.is_returning OR EXCLUDED.is_returning`,
  );
}

export async function recordKeylessCallerVisit(
  ip: string,
  userAgent: string,
  now: Date = new Date(),
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const weekStart = utcWeekStart(now);
    const day = utcDay(now);
    const nextWeek = addUtcWeeks(weekStart, 1);
    const saltNow = await ensureWeekSalt(db, weekStart);
    const saltNext = await ensureWeekSalt(db, nextWeek);
    if (!saltNow || !saltNext) return;

    const digestNow = callerDigest(saltNow, ip, userAgent);
    const callerHash = digestNow.toString("hex");
    const bitsNow = bloomBits(digestNow);
    const isReturning = await carryBitsPresent(db, weekStart, bitsNow);

    const digestNext = callerDigest(saltNext, ip, userAgent);
    const bitsNext = bloomBits(digestNext);
    await insertCarryBits(db, nextWeek, bitsNext);
    await upsertCallerDay(db, weekStart, callerHash, day, isReturning);
  } catch (error) {
    if (isMissingSchemaError(error)) return;
    throw error;
  }
}

/** Schedule a keyless check/decision visit count (no IP/UA stored). */
export function scheduleKeylessCallerRecord(headers: Headers): void {
  try {
    const ip = getClientIp(new Request("https://vet402.com/", { headers })) ?? "unknown";
    const ua = (headers.get("user-agent") ?? "").slice(0, 512);
    runAfterResponse(() =>
      recordKeylessCallerVisit(ip, ua).catch(logAndSwallowSafe("keyless_callers.record")),
    );
  } catch (error) {
    logAndSwallowSafe("keyless_callers.schedule")(error);
  }
}

type KeylessCallerWeek = {
  week_start: string;
  keyless_callers_7d: number;
  keyless_callers_2plus_days_7d: number;
  keyless_callers_returning_wow: number;
  in_progress?: true;
};

export async function readKeylessCallerStats(): Promise<{ weeks: KeylessCallerWeek[] }> {
  const db = getDb();
  if (!db) return { weeks: [] };
  const currentWeek = utcWeekStart();

  let closed: {
    week_start: string;
    callers: number;
    callers_2plus_days: number;
    returning_wow: number;
  }[] = [];
  try {
    closed = rowsOf<{
      week_start: string;
      callers: number;
      callers_2plus_days: number;
      returning_wow: number;
    }>(
      await db.execute(
        sql`SELECT week_start::text,
                   callers::int,
                   callers_2plus_days::int,
                   returning_wow::int
            FROM keyless_caller_weekly
            ORDER BY week_start DESC
            LIMIT 52`,
      ),
    );
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }

  let live: {
    callers: number;
    callers_2plus_days: number;
    returning_wow: number;
  } | null = null;
  try {
    live =
      rowsOf<{
        callers: number;
        callers_2plus_days: number;
        returning_wow: number;
      }>(
        await db.execute(sql`
          SELECT (SELECT count(DISTINCT caller_hash)::int FROM keyless_caller_days WHERE week_start = ${currentWeek}::date) AS callers,
                 (SELECT count(*)::int FROM (
                    SELECT caller_hash FROM keyless_caller_days
                    WHERE week_start = ${currentWeek}::date
                    GROUP BY caller_hash HAVING count(DISTINCT day) >= 2
                  ) s) AS callers_2plus_days,
                 (SELECT count(DISTINCT caller_hash)::int FROM keyless_caller_days
                  WHERE week_start = ${currentWeek}::date AND is_returning = true) AS returning_wow
        `),
      )[0] ?? null;
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }

  const weeks: KeylessCallerWeek[] = closed.map((row) => ({
    week_start: row.week_start,
    keyless_callers_7d: row.callers,
    keyless_callers_2plus_days_7d: row.callers_2plus_days,
    keyless_callers_returning_wow: row.returning_wow,
  }));

  let pendingClosed: {
    week_start: string;
    callers: number;
    callers_2plus_days: number;
    returning_wow: number;
  }[] = [];
  try {
    pendingClosed = rowsOf<{
      week_start: string;
      callers: number;
      callers_2plus_days: number;
      returning_wow: number;
    }>(
      await db.execute(sql`
        WITH pending AS (
          SELECT DISTINCT week_start FROM keyless_caller_days
          WHERE week_start < ${currentWeek}::date
            AND NOT EXISTS (
              SELECT 1 FROM keyless_caller_weekly w WHERE w.week_start = keyless_caller_days.week_start
            )
        )
        SELECT p.week_start::text,
               (SELECT count(DISTINCT caller_hash)::int FROM keyless_caller_days d
                WHERE d.week_start = p.week_start) AS callers,
               (SELECT count(*)::int FROM (
                  SELECT caller_hash FROM keyless_caller_days d
                  WHERE d.week_start = p.week_start
                  GROUP BY caller_hash HAVING count(DISTINCT day) >= 2
                ) s) AS callers_2plus_days,
               (SELECT count(DISTINCT caller_hash)::int FROM keyless_caller_days d
                WHERE d.week_start = p.week_start AND d.is_returning = true) AS returning_wow
        FROM pending p
        ORDER BY p.week_start DESC
      `),
    );
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }

  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  for (const row of pendingClosed) {
    if (!byWeek.has(row.week_start)) {
      byWeek.set(row.week_start, {
        week_start: row.week_start,
        keyless_callers_7d: row.callers,
        keyless_callers_2plus_days_7d: row.callers_2plus_days,
        keyless_callers_returning_wow: row.returning_wow,
      });
    }
  }

  const merged = [...byWeek.values()].sort((a, b) => b.week_start.localeCompare(a.week_start));

  if (live) {
    const current = byWeek.get(currentWeek);
    if (current) {
      current.keyless_callers_7d = live.callers;
      current.keyless_callers_2plus_days_7d = live.callers_2plus_days;
      current.keyless_callers_returning_wow = live.returning_wow;
      current.in_progress = true;
    } else {
      merged.unshift({
        week_start: currentWeek,
        keyless_callers_7d: live.callers,
        keyless_callers_2plus_days_7d: live.callers_2plus_days,
        keyless_callers_returning_wow: live.returning_wow,
        in_progress: true as const,
      });
    }
  }

  return { weeks: merged };
}