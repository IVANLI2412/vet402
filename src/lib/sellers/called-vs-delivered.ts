import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { deliveredPredicate, inconclusiveSettledPredicate, judgedSettledCount } from "@/lib/observatory/delivery";
import { pct1 } from "@/lib/util/pct";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { sellerHostSql } from "./host";
import { HOST_BADGE_WINDOW_DAYS } from "./reader";

type Db = NonNullable<ReturnType<typeof getDb>>;

export type HostCalledVsDelivered = {
  host: string;
  bazaar: {
    calls30d: number | null;
    listingsWithFigures: number;
    listings: number;
    payersLargestListing: number | null;
    lastCalledAt: string | null;
    observedOldestAt: string | null;
    observedNewestAt: string | null;
  };
  vet402: {
    windowDays: 30;
    settled: number;
    delivered: number;
    heldSettled: number;
    judged: number;
    deliveredPct: number | null;
  };
  readAt: string;
};

const HOST_SQL = sellerHostSql(sql`e.resource_key`);

function fmtUtc(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z").replace("T", " ").slice(0, 16);
}

export function buildHostCalledVsDelivered(input: {
  host: string;
  bazaar: HostCalledVsDelivered["bazaar"];
  vet402: Omit<HostCalledVsDelivered["vet402"], "windowDays" | "judged" | "deliveredPct">;
  readAt: string;
}): HostCalledVsDelivered {
  const judged = judgedSettledCount(input.vet402.settled, input.vet402.heldSettled);
  return {
    host: input.host,
    bazaar: input.bazaar,
    vet402: {
      windowDays: 30,
      settled: input.vet402.settled,
      delivered: input.vet402.delivered,
      heldSettled: input.vet402.heldSettled,
      judged,
      deliveredPct: pct1(input.vet402.delivered, judged),
    },
    readAt: input.readAt,
  };
}

export function calledVsDeliveredLines(data: HostCalledVsDelivered): { bazaar: string[]; vet402: string[] } {
  const bazaar: string[] = [];
  const vet402: string[] = [];
  const b = data.bazaar;
  const v = data.vet402;
  const hasBazaar =
    b.listingsWithFigures > 0 && b.calls30d !== null && b.observedNewestAt !== null;
  if (hasBazaar) {
    bazaar.push(
      `Across ${b.listingsWithFigures} of ${b.listings} listings. Coinbase counts calls settled through its own facilitator. vet402 did not make or check these calls.`,
    );
    const oldest = b.observedOldestAt ? fmtUtc(b.observedOldestAt) : null;
    const newest = b.observedNewestAt ? fmtUtc(b.observedNewestAt) : null;
    if (oldest && newest && oldest !== newest) {
      bazaar.push(`Read by vet402 from the Bazaar catalog between ${oldest} and ${newest} UTC.`);
    } else if (newest) {
      bazaar.push(`Read by vet402 from the Bazaar catalog at ${newest} UTC.`);
    }
    if (b.payersLargestListing !== null) {
      bazaar.push(`Largest single listing: ${b.payersLargestListing} unique payers, as counted by the CDP Bazaar.`);
    }
    if (b.lastCalledAt) {
      bazaar.push(`Last call the Bazaar reports: ${fmtUtc(b.lastCalledAt)} UTC.`);
    }
  } else {
    bazaar.push(
      "The CDP Bazaar reports no call count with a recorded read time for this host's listings.",
    );
  }
  if (v.settled === 0) {
    vet402.push(`vet402 has no settled purchase from this host in the last ${v.windowDays} days.`);
  } else if (v.judged > 0) {
    vet402.push(
      `${v.delivered} delivered of ${v.judged} settled purchases vet402 could judge.`,
    );
    if (v.heldSettled > 0) {
      vet402.push(
        `${v.heldSettled} settled purchases got an HTTP 4xx answer and are held as inconclusive.`,
      );
    }
  } else {
    vet402.push(`No settled purchase vet402 could judge in the last ${v.windowDays} days.`);
    if (v.heldSettled > 0) {
      vet402.push(
        `${v.heldSettled} settled purchases got an HTTP 4xx answer and are held as inconclusive.`,
      );
    }
  }
  return { bazaar, vet402 };
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/**
 * そのホストの「呼ばれた回数（Bazaar）」と「vet402 の届いた率」。quality_observed_at の列がまだ無い DB（scripts/sql/2026-11-15-
 * bazaar-quality-observed.sql を当てる前）では null を返す。頁はそのとき節ごと隠す（落とさない）。
 */
export async function readHostCalledVsDelivered(db: Db, host: string): Promise<HostCalledVsDelivered | null> {
  const readAt = new Date().toISOString();
  let bazaarRaw: unknown;
  try {
    bazaarRaw = await db.execute(sql`
    SELECT
      count(*)::int AS listings,
      count(*) FILTER (WHERE quality_observed_at IS NOT NULL AND quality_calls_30d IS NOT NULL)::int AS listings_with_figures,
      coalesce(sum(quality_calls_30d) FILTER (WHERE quality_observed_at IS NOT NULL AND quality_calls_30d IS NOT NULL), 0)::bigint AS calls_30d,
      max(quality_payers_30d) FILTER (WHERE quality_observed_at IS NOT NULL AND quality_calls_30d IS NOT NULL) AS payers_max,
      max(quality_last_called_at) FILTER (WHERE quality_observed_at IS NOT NULL AND quality_calls_30d IS NOT NULL) AS last_called,
      min(quality_observed_at) FILTER (WHERE quality_observed_at IS NOT NULL AND quality_calls_30d IS NOT NULL) AS observed_oldest,
      max(quality_observed_at) FILTER (WHERE quality_observed_at IS NOT NULL AND quality_calls_30d IS NOT NULL) AS observed_newest
    FROM x402_endpoints e
    WHERE ${HOST_SQL} = ${host} AND status = 'active'`);
  } catch (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
  const br = rowsOf(bazaarRaw)[0] ?? {};
  const listings = Number(br.listings ?? 0);
  const listingsWithFigures = Number(br.listings_with_figures ?? 0);
  const callsSum = br.calls_30d !== undefined && br.calls_30d !== null ? Number(br.calls_30d) : 0;

  const vetRaw = await db.execute(sql`
    SELECT count(*) FILTER (WHERE pu.status = 'settled')::int AS settled,
           count(*) FILTER (WHERE pu.status = 'settled' AND ${sql.raw(deliveredPredicate("pu"))})::int AS delivered,
           count(*) FILTER (WHERE ${sql.raw(inconclusiveSettledPredicate("pu"))})::int AS held_settled
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${HOST_SQL} = ${host}
      AND pu.attempted_at >= now() - make_interval(days => ${HOST_BADGE_WINDOW_DAYS}::int)`);
  const vr = rowsOf(vetRaw)[0] ?? {};
  const settled = Number(vr.settled ?? 0);
  const delivered = Number(vr.delivered ?? 0);
  const heldSettled = Number(vr.held_settled ?? 0);

  return buildHostCalledVsDelivered({
    host,
    readAt,
    bazaar: {
      calls30d: listingsWithFigures > 0 ? callsSum : null,
      listingsWithFigures,
      listings,
      payersLargestListing:
        br.payers_max !== null && br.payers_max !== undefined ? Number(br.payers_max) : null,
      lastCalledAt: br.last_called ? new Date(String(br.last_called)).toISOString() : null,
      observedOldestAt: br.observed_oldest ? new Date(String(br.observed_oldest)).toISOString() : null,
      observedNewestAt: br.observed_newest ? new Date(String(br.observed_newest)).toISOString() : null,
    },
    vet402: { settled, delivered, heldSettled },
  });
}