import net from "node:net";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { runAfterResponse } from "@/lib/util/after-response";
import { rowsOf } from "@/lib/settlements/upsert";
import { logAndSwallowSafe } from "@/lib/util/log-safe";

export type BadgeKind = "address" | "agent" | "endpoint" | "host";

function refererHost(referer: string | null): string {
  if (!referer || referer.length > 2048) return "(none)";
  try {
    let hostname = new URL(referer).hostname.toLowerCase() || "(none)";
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    if (hostname === "(none)") return hostname;
    if (net.isIP(hostname) !== 0) return "(none)";
    return hostname;
  } catch {
    return "(none)";
  }
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function upsertBadgeFetch(
  referer: string | null,
  badgeKind: BadgeKind,
  now: Date = new Date(),
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const day = utcDay(now);
  const host = refererHost(referer);
  try {
    await db.execute(
      sql`INSERT INTO badge_fetch_daily (day, referer_host, badge_kind, fetches)
          VALUES (${day}::date, ${host}::text, ${badgeKind}::text, 1::int)
          ON CONFLICT (day, referer_host, badge_kind)
          DO UPDATE SET fetches = badge_fetch_daily.fetches + 1`,
    );
  } catch (error) {
    if (isMissingSchemaError(error)) return;
    throw error;
  }
}

export function scheduleBadgeFetch(referer: string | null, badgeKind: BadgeKind): void {
  try {
    runAfterResponse(() =>
      upsertBadgeFetch(referer, badgeKind).catch(logAndSwallowSafe("badge_fetch.record")),
    );
  } catch (error) {
    logAndSwallowSafe("badge_fetch.schedule")(error);
  }
}

export async function readBadgeFetches(days: number): Promise<{
  days: number;
  rows: { day: string; referer_host: string; badge_kind: string; fetches: number }[];
}> {
  const db = getDb();
  if (!db) return { days, rows: [] };
  const clamped = Math.min(365, Math.max(1, days));
  try {
    const rows = rowsOf<{
      day: string;
      referer_host: string;
      badge_kind: string;
      fetches: number;
    }>(
      await db.execute(
        sql`SELECT day::text, referer_host, badge_kind, fetches::int
            FROM badge_fetch_daily
            WHERE day >= ((now() AT TIME ZONE 'UTC')::date - (${clamped}::int - 1))
            ORDER BY day DESC, fetches DESC`,
      ),
    );
    return { days: clamped, rows };
  } catch (error) {
    if (isMissingSchemaError(error)) return { days: clamped, rows: [] };
    throw error;
  }
}