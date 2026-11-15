// ============================================================
// Find API — one SQL read per request (2026-11-16 U1).
// Aggregates paid attempts first, filters by delivered rate, joins active
// listings that match the term, orders by Wilson lower bound, then LIMIT.
// MCP readFindSellers is separate and unchanged.
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { deliveredPredicate } from "@/lib/observatory/delivery";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";

export type Db = NonNullable<ReturnType<typeof getDb>>;

export type FindListing = {
  observatoryId: string;
  resourceKey: string;
  url: string;
  description: string | null;
  priceAmount: string | null;
  network: string | null;
  delivered30d: number;
  paidAttempts30d: number;
  lastAttemptAt: string | null;
};

export type FindAlternativesOpts = {
  limit: number;
  minDeliveredPct: number;
  windowDays: number;
};

const ISO = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`);
const DELIVERED = sql.raw(deliveredPredicate("pu"));
const WILSON_Z_SQL = sql.raw("1.96::float8");
const WILSON_Z2_SQL = sql.raw("(1.96::float8 * 1.96::float8)");

const PAID_LIST = sql.join(
  PAID_ATTEMPT_STATUSES.map((s) => sql`${s}::text`),
  sql`, `,
);

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function findAlternativesSql(like: string, opts: FindAlternativesOpts) {
  const { limit, minDeliveredPct, windowDays } = opts;
  return sql`
    WITH l1 AS (
      SELECT pu.endpoint_id,
             count(*)::int AS paid_attempts_30d,
             count(*) FILTER (WHERE ${DELIVERED})::int AS delivered_30d,
             max(pu.attempted_at) AS last_attempt_at
      FROM x402_l1_purchases pu
      WHERE pu.attempted_at > now() - (${windowDays}::int * interval '1 day')
        AND pu.status IN (${PAID_LIST})
      GROUP BY pu.endpoint_id
      HAVING count(*) >= 1
        AND count(*) FILTER (WHERE ${DELIVERED}) * 100 >= ${minDeliveredPct}::int * count(*)
    ),
    ranked AS (
      SELECT e.id,
             e.resource_key,
             e.resource_url,
             left(e.description, 2000) AS description,
             e.price_amount,
             e.network,
             l1.delivered_30d,
             l1.paid_attempts_30d,
             l1.last_attempt_at,
             CASE WHEN l1.paid_attempts_30d > 0 THEN
               (
                 (l1.delivered_30d::float8 / l1.paid_attempts_30d::float8)
                 + ${WILSON_Z2_SQL} / (2 * l1.paid_attempts_30d::float8)
                 - ${WILSON_Z_SQL} * sqrt(GREATEST(0::float8,
                   ((l1.delivered_30d::float8 / l1.paid_attempts_30d::float8)
                     * (1::float8 - l1.delivered_30d::float8 / l1.paid_attempts_30d::float8)
                     + ${WILSON_Z2_SQL} / (4 * l1.paid_attempts_30d::float8))
                   / l1.paid_attempts_30d::float8
                 ))
               ) / (1::float8 + ${WILSON_Z2_SQL} / l1.paid_attempts_30d::float8)
             ELSE 0::float8 END AS wilson_lb
      FROM l1
      JOIN x402_endpoints e ON e.id = l1.endpoint_id
      WHERE e.status = 'active'::text
        AND (e.resource_key ILIKE ${like}::text OR e.description ILIKE ${like}::text)
    )
    SELECT id::text AS id,
           resource_key,
           resource_url,
           description,
           price_amount,
           network,
           delivered_30d,
           paid_attempts_30d,
           to_char(last_attempt_at AT TIME ZONE 'utc', ${ISO}) AS last_attempt_at
    FROM ranked
    ORDER BY wilson_lb DESC,
             delivered_30d DESC,
             last_attempt_at DESC,
             resource_key ASC
    LIMIT ${limit}::int`;
}

function toListing(r: Record<string, unknown>): FindListing {
  return {
    observatoryId: String(r.id),
    resourceKey: String(r.resource_key),
    url: String(r.resource_url),
    description: str(r.description),
    priceAmount: str(r.price_amount),
    network: str(r.network),
    delivered30d: Number(r.delivered_30d ?? 0),
    paidAttempts30d: Number(r.paid_attempts_30d ?? 0),
    lastAttemptAt: str(r.last_attempt_at),
  };
}

export async function readFindAlternatives(
  db: Db,
  like: string,
  opts: FindAlternativesOpts,
): Promise<{ fetchedAt: string; listings: FindListing[] }> {
  const fetchedAt = new Date().toISOString();
  const raw = await db.execute(findAlternativesSql(like, opts));
  return { fetchedAt, listings: rowsOf(raw).map(toListing) };
}