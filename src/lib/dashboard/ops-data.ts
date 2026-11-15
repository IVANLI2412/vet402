// ============================================================
// P3 運用画面の DB 読み出し（買い手・売り手）。
// ============================================================
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { decisionUsageDaily, x402Endpoints, x402L1Purchases, x402Payments } from "@/lib/db/schema";
import { getE6ChainReader } from "@/lib/observatory/e6-chain-reader";
import { getTradeDisputeStore, splitCurrentAndHistory, type TradeDisputeLegRow } from "@/lib/observatory/trade-dispute-store";
import { isP2LiveComplete } from "@/lib/observatory/p2-live";
import {
  MIN_CONSECUTIVE_FAILS_TO_PUBLISH,
  parseProbeVerdicts,
  publicProbeWord,
} from "@/lib/observatory/l0-verdict";
import {
  deliveredPredicate,
  inconclusivePredicate,
} from "@/lib/observatory/delivery";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";
import { readStateAggregates } from "@/lib/observatory/state-reads";
import {
  buildBuyerCard,
  buildSellerCard,
  type BuyerCard,
  type SellerCardResult,
} from "@/lib/dashboard/ops-card";
import {
  type SellerDashboardProof,
  verifySellerDashboardAccess,
} from "@/lib/dashboard/seller-access";

const BUYER_USAGE_DAYS = 30;
export const DISPUTE_PURCHASE_LIMIT = 1000;
const PUBLIC_READ_CHAIN = "eip155:84532";

let disputePurchaseLimitForTests: number | null = null;

export function setDisputePurchaseLimitForTests(limit: number | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setDisputePurchaseLimitForTests is not allowed in production");
  }
  disputePurchaseLimitForTests = limit;
}

function effectiveDisputePurchaseLimit(): number {
  return disputePurchaseLimitForTests ?? DISPUTE_PURCHASE_LIMIT;
}

const PAID_STATUS_SQL = PAID_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(", ");
function latestLegAcceptedAt(bucket: {
  payer: TradeDisputeLegRow | null;
  seller: TradeDisputeLegRow | null;
}): number {
  const a = bucket.payer ? Date.parse(bucket.payer.acceptedAt) : 0;
  const b = bucket.seller ? Date.parse(bucket.seller.acceptedAt) : 0;
  return Math.max(a, b);
}

function tradeBucketsFromLegs(
  legs: TradeDisputeLegRow[],
): Map<string, { payer: TradeDisputeLegRow[]; seller: TradeDisputeLegRow[] }> {
  const byTrade = new Map<string, { payer: TradeDisputeLegRow[]; seller: TradeDisputeLegRow[] }>();
  for (const leg of legs) {
    let bucket = byTrade.get(leg.tradeId);
    if (!bucket) {
      bucket = { payer: [], seller: [] };
      byTrade.set(leg.tradeId, bucket);
    }
    if (leg.side === "payer") bucket.payer.push(leg);
    else bucket.seller.push(leg);
  }
  return byTrade;
}

/** 両側が今の主張を持つ取引の本数（売り手 ops カード用）。 */
export async function countPublicTradeDisputes(
  legs: TradeDisputeLegRow[],
  _reader: unknown = null,
  disputeLimit: number = effectiveDisputePurchaseLimit(),
): Promise<number> {
  void _reader;
  const byTrade = tradeBucketsFromLegs(legs);
  const tradesToCount = [...byTrade.entries()]
    .map(([tradeId, bucket]) => {
      const payer = splitCurrentAndHistory(bucket.payer).current;
      const seller = splitCurrentAndHistory(bucket.seller).current;
      return { tradeId, payer, seller, at: latestLegAcceptedAt({ payer, seller }) };
    })
    .filter((t) => t.payer && t.seller)
    .sort((a, b) => b.at - a.at)
    .slice(0, disputeLimit);
  return tradesToCount.length;
}

function sumUsdcUnits(rows: { amount: string | null }[]): string {
  let total = 0n;
  for (const row of rows) {
    if (!row.amount) continue;
    try {
      total += BigInt(row.amount);
    } catch {
      // skip non-numeric
    }
  }
  return total.toString();
}

export async function fetchBuyerKeyUsage(
  apiKeyId: string,
): Promise<{ total: number; byChain: { chain: string; count: number }[] }> {
  const db = getDb();
  if (!db) return { total: 0, byChain: [] };
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - BUYER_USAGE_DAYS);
  const day = since.toISOString().slice(0, 10);
  try {
    const rows = await db
      .select({
        chain: decisionUsageDaily.chain,
        count: sql<number>`sum(${decisionUsageDaily.count})::int`,
      })
      .from(decisionUsageDaily)
      .where(and(eq(decisionUsageDaily.apiKeyId, apiKeyId), gte(decisionUsageDaily.day, day)))
      .groupBy(decisionUsageDaily.chain);
    const byChain = rows
      .map((r) => ({ chain: r.chain, count: Number(r.count ?? 0) }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
    const total = byChain.reduce((n, r) => n + r.count, 0);
    return { total, byChain };
  } catch (error) {
    if (isMissingSchemaError(error)) return { total: 0, byChain: [] };
    throw error;
  }
}

export async function fetchBuyerPayments(apiKeyId: string): Promise<{
  paymentCount: number;
  verifiedUsdcUnitsSum: string;
  unverifiedOnChainCount: number;
}> {
  const db = getDb();
  if (!db) return { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 };
  try {
    const [agg] = await db
      .select({
        paymentCount: sql<number>`count(*)::int`,
        verifiedSum: sql<string>`coalesce(sum((${x402Payments.onchainAmount})::numeric) filter (where ${x402Payments.amountVerified} = true), 0)::text`,
        unverified: sql<number>`count(*) filter (where ${x402Payments.amountVerified} is distinct from true)::int`,
      })
      .from(x402Payments)
      .where(eq(x402Payments.apiKeyId, apiKeyId));
    return {
      paymentCount: Number(agg?.paymentCount ?? 0),
      verifiedUsdcUnitsSum: String(agg?.verifiedSum ?? "0"),
      unverifiedOnChainCount: Number(agg?.unverified ?? 0),
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 };
    throw error;
  }
}

export type LoadBuyerCardAggregates = {
  stats: {
    l1: Pick<
      Awaited<ReturnType<typeof readStateAggregates>>["stats"]["l1"],
      "attempts" | "delivered" | "inconclusive" | "awaitingReread"
    >;
  };
};

export type LoadBuyerCardDeps = {
  fetchKeyUsage?: (apiKeyId: string) => ReturnType<typeof fetchBuyerKeyUsage>;
  fetchPayments?: (apiKeyId: string) => ReturnType<typeof fetchBuyerPayments>;
  readAggregates?: () => Promise<LoadBuyerCardAggregates>;
};

export async function loadBuyerCard(apiKeyId: string, deps?: LoadBuyerCardDeps): Promise<BuyerCard> {
  const fetchKeyUsage = deps?.fetchKeyUsage ?? fetchBuyerKeyUsage;
  const fetchPayments = deps?.fetchPayments ?? fetchBuyerPayments;
  const readAggregates = deps?.readAggregates ?? readStateAggregates;
  const [keyUsage, payments, aggregates] = await Promise.all([
    fetchKeyUsage(apiKeyId),
    fetchPayments(apiKeyId),
    readAggregates(),
  ]);
  const l1 = aggregates.stats.l1;
  return buildBuyerCard({
    yourKey: { ...keyUsage, days: BUYER_USAGE_DAYS },
    payments: {
      paymentCount: payments.paymentCount,
      verifiedUsdcUnitsSum: payments.verifiedUsdcUnitsSum,
      unverifiedOnChainCount: payments.unverifiedOnChainCount,
    },
    measurementL1: {
      attempts: l1.attempts,
      delivered: l1.delivered,
      inconclusive: l1.inconclusive,
      awaitingReread: l1.awaitingReread,
    },
  });
}

export type SellerOpsRaw = Parameters<typeof buildSellerCard>[0];

let sellerOpsLoaderForTests: ((wallet: string) => Promise<SellerOpsRaw>) | null = null;

export function setSellerOpsLoaderForTests(loader: ((wallet: string) => Promise<SellerOpsRaw>) | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setSellerOpsLoaderForTests is not allowed in production");
  }
  sellerOpsLoaderForTests = loader;
}

export async function fetchSellerOpsFromDb(wallet: string): Promise<SellerOpsRaw> {
  const db = getDb();
  const w = wallet.toLowerCase();
  const empty: SellerOpsRaw = {
    wallet: w,
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: {
      purchaseIdsChecked: 0,
      truncated: false,
      recordsPresent: 0,
      disputeCount: 0,
      p2Live: isP2LiveComplete(),
      p2Unavailable: false,
    },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  };
  if (!db) return empty;

  try {
    const revenueRaw = await db.execute(sql`
      SELECT
        count(*) filter (where status = 'settled')::int AS measurement_count,
        coalesce(sum(amount_units::numeric) filter (where status = 'settled'), 0)::text AS measurement_units
      FROM x402_l1_purchases
      WHERE lower(pay_to) = ${w}
    `);
    const revenueRows = (Array.isArray(revenueRaw) ? revenueRaw : (revenueRaw as { rows?: unknown[] }).rows ?? []) as {
      measurement_count: number;
      measurement_units: string;
    }[];
    const rev0 = revenueRows[0];

    const reportedRows = await db
      .select({
        onchainAmount: x402Payments.onchainAmount,
      })
      .from(x402Payments)
      .where(
        and(
          sql`lower(${x402Payments.payee}) = ${w}`,
          eq(x402Payments.amountVerified, true),
          sql`${x402Payments.apiKeyId} is not null`,
        ),
      );
    const reportedVerifiedUnitsSum = sumUsdcUnits(
      reportedRows.map((r) => ({ amount: r.onchainAmount })),
    );

    const l1Raw = await db.execute(sql`
      SELECT count(*)::int AS attempts,
             count(*) filter (where ${sql.raw(deliveredPredicate())})::int AS delivered,
             count(*) filter (where ${sql.raw(inconclusivePredicate())})::int AS inconclusive,
             count(*) filter (where status = 'settle_claimed')::int AS awaiting_reread
      FROM x402_l1_purchases
      WHERE lower(pay_to) = ${w}
        AND status IN (${sql.raw(PAID_STATUS_SQL)})
    `);
    const l1List = (Array.isArray(l1Raw) ? l1Raw : (l1Raw as { rows?: unknown[] }).rows ?? []) as {
      attempts: number;
      delivered: number;
      inconclusive: number;
      awaiting_reread: number;
    }[];

    const disputeLimit = effectiveDisputePurchaseLimit();
    const purchaseFetchLimit = disputeLimit + 1;
    const purchaseRowsRaw = await db
      .select({ id: x402L1Purchases.id })
      .from(x402L1Purchases)
      .where(sql`lower(${x402L1Purchases.payTo}) = ${w}`)
      .orderBy(desc(x402L1Purchases.attemptedAt))
      .limit(purchaseFetchLimit);
    const purchaseTruncated = purchaseRowsRaw.length > disputeLimit;
    const purchaseRows = purchaseTruncated ? purchaseRowsRaw.slice(0, disputeLimit) : purchaseRowsRaw;

    const tdStore = getTradeDisputeStore();
    let recordsPresent = 0;
    let disputeCount = 0;
    let p2Unavailable = !tdStore;
  if (tdStore) {
      let legs: TradeDisputeLegRow[];
      try {
        legs = await tdStore.listByReceiver(w, disputeLimit * 2);
      } catch (error) {
        if ((error as { code?: string }).code === "disputes_unavailable") {
          p2Unavailable = true;
          legs = [];
        } else {
          throw error;
        }
      }
      const byTrade = tradeBucketsFromLegs(legs);
      const reader = getE6ChainReader(PUBLIC_READ_CHAIN);
      for (const [, bucket] of byTrade) {
        if (bucket.payer.length > 0 || bucket.seller.length > 0) recordsPresent++;
      }
      disputeCount = await countPublicTradeDisputes(legs, reader, disputeLimit);
    }

    const repRaw = await db.execute(sql`
      WITH latest AS (
        SELECT e.id, e.status,
               lp.verdicts AS verdicts
        FROM x402_endpoints e
        LEFT JOIN LATERAL (
          SELECT array_agg(v.verdict ORDER BY v.probed_at DESC) AS verdicts
          FROM (
            SELECT verdict, probed_at FROM x402_l0_probes p
            WHERE p.endpoint_id = e.id
            ORDER BY probed_at DESC
            LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
          ) v
        ) lp ON true
        WHERE lower(e.pay_to) = ${w}
      )
      SELECT status, verdicts FROM latest
    `);
    const repList = (Array.isArray(repRaw) ? repRaw : (repRaw as { rows?: unknown[] }).rows ?? []) as {
      status: string;
      verdicts: string[] | null;
    }[];
    const reputation = { pass: 0, fail: 0, withdrawn: 0, unverified: 0 };
    for (const row of repList) {
      const word = publicProbeWord(String(row.status), parseProbeVerdicts(row.verdicts as string[] | string | null));
      if (word === "pass") reputation.pass++;
      else if (word === "fail") reputation.fail++;
      else if (word === "withdrawn") reputation.withdrawn++;
      else reputation.unverified++;
    }

    const l1 = l1List[0];
    return {
      wallet: w,
      revenue: {
        measurementSettledCount: Number(rev0?.measurement_count ?? 0),
        measurementSettledUnitsSum: String(rev0?.measurement_units ?? "0").split(".")[0] ?? "0",
        reportedVerifiedCount: reportedRows.length,
        reportedVerifiedUnitsSum: reportedVerifiedUnitsSum,
      },
      l1: {
        attempts: Number(l1?.attempts ?? 0),
        delivered: Number(l1?.delivered ?? 0),
        inconclusive: Number(l1?.inconclusive ?? 0),
        awaitingReread: Number(l1?.awaiting_reread ?? 0),
      },
      disputes: {
        purchaseIdsChecked: purchaseRows.length,
        truncated: purchaseTruncated,
        recordsPresent,
        disputeCount,
        p2Live: isP2LiveComplete(),
        p2Unavailable,
      },
      reputation,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return empty;
    throw error;
  }
}

export async function loadSellerCard(proof: SellerDashboardProof): Promise<SellerCardResult> {
  const verification = await verifySellerDashboardAccess(proof);
  if (!verification.ok) {
    return { ok: false, reason: verification.reason };
  }
  const wallet = proof.kind === "payto_signature" ? proof.wallet.toLowerCase() : "";
  const loader = sellerOpsLoaderForTests ?? fetchSellerOpsFromDb;
  const raw = await loader(wallet);
  return { ok: true, card: buildSellerCard(raw) };
}
