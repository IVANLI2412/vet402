// ============================================================
// 評判ページ（/x402/sellers/[host]）用: 届いた記録だけを索引する 50 ホスト。
// 選定は純関数 selectReputationHosts。一覧は getSellerBoardCached から作る。
// ============================================================
import { unstable_cache } from "next/cache";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { isDelivered } from "@/lib/observatory/delivery";
import { paymentChainLabel } from "@/lib/observatory/chains";
import type { SellerDetail, SellerListing, SellerSummary } from "./board";
import { getSellerBoardCached, getSellerDetailCached } from "./cached";
import { parseSellerHostParam } from "./host";

export const REPUTATION_HOST_LIMIT = 50;
export const REPUTATION_DETAIL_READ_LIMIT = 150;

export function reputationSellerPath(host: string): string {
  return `/x402/sellers/${encodeURIComponent(host)}`;
}

/** 届いた出品だけが 2 件以上で、失敗系カウントがすべて 0 のホストを delivered 降順→host 昇順で limit 件。 */
export function selectReputationHosts(sellers: SellerSummary[], limit = 50): string[] {
  const eligible = sellers.filter(
    (s) =>
      s.delivered >= 2 &&
      s.seller === 0 &&
      s.vet402 === 0 &&
      s.unsorted === 0 &&
      s.notPaid === 0 &&
      s.pending === 0 &&
      parseSellerHostParam(s.host) === s.host,
  );
  eligible.sort((a, b) => b.delivered - a.delivered || a.host.localeCompare(b.host));
  return eligible.slice(0, limit).map((s) => s.host);
}

function listingPath(resourceKey: string, host: string): string {
  const prefix = `${host}/`;
  if (resourceKey.startsWith(prefix)) return `/${resourceKey.slice(host.length)}`;
  const slash = resourceKey.indexOf("/");
  return slash >= 0 ? resourceKey.slice(slash) : "/";
}

/** vet402 が Base で購入を試した出品（latest がある行）。未購入は含めない。 */
export function purchasedListings(detail: SellerDetail): SellerListing[] {
  return detail.listings.filter((l) => l.latest !== null);
}

export function deliveredListings(detail: SellerDetail): SellerListing[] {
  return purchasedListings(detail).filter((l) => l.latest?.bucket === "delivered");
}

/** 評判表: その出品の全チェーンのうち、いちばん新しい届いた購入。 */
export function newestDeliveredPurchase(
  l: SellerListing,
): { attemptedAt: string; network: string | null } | null {
  const candidates: { attemptedAt: string; network: string | null }[] = [];
  if (l.latest?.bucket === "delivered") {
    candidates.push({ attemptedAt: l.latest.facts.attemptedAt, network: l.latest.facts.network });
  }
  const other = l.otherChain;
  if (other && isDelivered(other)) {
    candidates.push({ attemptedAt: other.attemptedAt, network: other.network });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
  return candidates[0]!;
}

/** 評判頁の通知リンク先: 全出品のうち、いちばん新しい届いた購入の記録 endpoint id。 */
export function latestDeliveredRecordId(detail: SellerDetail): string | null {
  let best: { attemptedAt: string; endpointId: string } | null = null;
  for (const l of deliveredListings(detail)) {
    const row = newestDeliveredPurchase(l);
    if (!row) continue;
    if (!best || row.attemptedAt > best.attemptedAt) {
      best = { attemptedAt: row.attemptedAt, endpointId: l.endpointId };
    }
  }
  return best?.endpointId ?? null;
}

function otherChainBlocksReputation(l: SellerListing): boolean {
  const other = l.otherChain;
  const base = l.latest;
  if (!other || !base) return false;
  if (other.attemptedAt <= base.facts.attemptedAt) return false;
  return !isDelivered(other);
}

/** 1 出品が評判表に載る前の条件（Base 最新が delivered、より新しい他チェーンが delivered に分類できないときは不可）。 */
export function reputationListingEligible(l: SellerListing): boolean {
  if (!l.latest || l.latest.bucket !== "delivered") return false;
  if (otherChainBlocksReputation(l)) return false;
  return true;
}

/** 評判頁に載せる前の詳細適格（禁止語・withdrawn は reputationPageEligible）。 */
export function reputationDetailEligible(detail: SellerDetail): boolean {
  const s = detail.summary;
  if (
    s.delivered < 2 ||
    s.seller !== 0 ||
    s.vet402 !== 0 ||
    s.unsorted !== 0 ||
    s.notPaid !== 0 ||
    s.pending !== 0
  ) {
    return false;
  }
  if (parseSellerHostParam(detail.host) !== detail.host) return false;
  if ((detail.withdrawnRoutes ?? []).length > 0) return false;
  const bought = purchasedListings(detail);
  if (bought.length < 2) return false;
  return bought.every(reputationListingEligible);
}

/** 評判頁の本文相当（禁止語検査用・小文字化）。描画と同じ語彙（host・path・鎖名・JSON-LD の名前）。 */
export function reputationBodyLowercase(detail: SellerDetail): string {
  const host = detail.host;
  const listings = deliveredListings(detail);
  const path = reputationSellerPath(host);
  const parts = [
    `Does ${host} deliver?`,
    `vet402 bought from ${host} with real x402 payments.`,
    `At each of the ${listings.length} listings vet402 bought, the latest purchase delivered a response.`,
    `as of ${detail.fetchedAt.slice(0, 10)}`,
    "Records are measurements, not a guarantee.",
    host,
    path,
    "home",
    "x402",
  ];
  for (const l of listings) {
    parts.push(listingPath(l.resourceKey, host));
    const newest = newestDeliveredPurchase(l);
    if (newest?.network) parts.push(newest.attemptedAt, paymentChainLabel(newest.network));
  }
  return parts.join(" ").toLowerCase();
}

export function reputationForbiddenInBody(detail: SellerDetail): boolean {
  const body = reputationBodyLowercase(detail);
  return REPUTATION_FORBIDDEN_WORDS.some((w) => body.includes(w));
}

export function reputationPageEligible(detail: SellerDetail): boolean {
  return reputationDetailEligible(detail) && !reputationForbiddenInBody(detail);
}

export const REPUTATION_FORBIDDEN_WORDS = [
  "fail",
  "failed",
  "failure",
  "not delivered",
  "undelivered",
  "refund",
  "dispute",
  "scam",
  "error",
  "unsorted",
  "under review",
  "seller's side",
  "vet402's side",
  "problem",
  "broken",
  "unreliable",
  "warning",
  "risk",
  "did not",
  "\u2014",
  "\u2013",
  ";",
] as const;

async function collectReputationHosts(): Promise<string[]> {
  const board = await getSellerBoardCached();
  const candidates = selectReputationHosts(board.sellers, board.sellers.length);
  const hosts: string[] = [];
  let reads = 0;
  for (const host of candidates) {
    if (hosts.length >= REPUTATION_HOST_LIMIT) break;
    if (reads >= REPUTATION_DETAIL_READ_LIMIT) break;
    reads++;
    const detail = await getSellerDetailCached(host).catch(() => null);
    if (detail && reputationPageEligible(detail)) hosts.push(host);
  }
  return hosts;
}

export const getReputationHostsCached: () => Promise<string[]> = unstable_cache(
  collectReputationHosts,
  ["sellers:reputation-hosts:v2"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);