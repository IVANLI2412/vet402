import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { rowsOf } from "@/lib/settlements/upsert";

export async function readWatchSellersInterest(days: number): Promise<{ days: number; watch_sellers_interest: number }> {
  const clamped = Math.min(365, Math.max(1, days));
  const db = getDb();
  if (!db) return { days: clamped, watch_sellers_interest: 0 };
  try {
    const rows = rowsOf<{ total: number }>(
      await db.execute(
        sql`SELECT coalesce(sum(count), 0)::int AS total
            FROM site_events_daily
            WHERE event = 'watch_sellers_interest'
              AND day >= ((now() AT TIME ZONE 'UTC')::date - (${clamped}::int - 1))`,
      ),
    );
    const total = rows[0]?.total ?? 0;
    return { days: clamped, watch_sellers_interest: total };
  } catch (error) {
    if (isMissingSchemaError(error)) return { days: clamped, watch_sellers_interest: 0 };
    throw error;
  }
}