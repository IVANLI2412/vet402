import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { rowsOf } from "@/lib/settlements/upsert";

export type ReferralSourceRow = { source: string; page_views: number };

export async function readReferralPageViews(days: number): Promise<{
  days: number;
  by_source: ReferralSourceRow[];
}> {
  const clamped = Math.min(365, Math.max(1, days));
  const db = getDb();
  if (!db) return { days: clamped, by_source: [] };
  try {
    const rows = rowsOf<{ source: string; page_views: number }>(
      await db.execute(
        sql`SELECT source, coalesce(sum(count), 0)::int AS page_views
            FROM site_events_daily
            WHERE event = 'page_view'
              AND day >= ((now() AT TIME ZONE 'UTC')::date - (${clamped}::int - 1))
            GROUP BY source
            ORDER BY page_views DESC, source ASC`,
      ),
    );
    return { days: clamped, by_source: rows };
  } catch (error) {
    if (isMissingSchemaError(error)) return { days: clamped, by_source: [] };
    throw error;
  }
}