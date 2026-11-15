// ============================================================
// 売り手の payTo ごとの返金額（C4・2026-11-16 依頼主の決定で「購入1件ずつの照合」から「payTo 単位の金額」へ）。
//
// 何を出すか（payTo ごと）:
//   paid    売り手側の失敗（isBadPaid）で、vet402 の Base の払う側が払った額の合計。30日の窓を読み終えた失敗だけ。
//   back    その各失敗の後 30日以内に、その payTo から vet402 の Base の払う側の財布へ戻った USDC の送金の合計。
//           1つの送金は1回だけ数え、合計は paid で切る。
//   rate    back ÷ paid。paid が 0 なら null（率を出さない）。
//   refund_transfers は戻った額に数えた送金の本数（paid で切った所まで）。購入とは結びつけない（どの購入への返金かは
//   送金だけでは決まらないため）。受け取る財布は vet402 の Base の払う側のどちらでもよい。
// 分けた返金（500+500）を2件の返金とは数えない。最大マッチングは要らない。
//
// 運営者の除外: payTo が運営者の番地（isOperatorPayTo）か vet402 の Base の払う側の財布そのものなら、その payTo は数えない
// （環境変数が空でも払う側の財布は外れる）。
// DB も RPC も読まない純関数。
// ============================================================
import { ACCEPTED_NOT_DONE_HTTP, isDelivered, isInconclusive } from "@/lib/observatory/delivery";
import { isOperatorPayTo } from "@/lib/observatory/operator";
import { BASE_PAYER_PERIODS } from "@/lib/sellers/payers";

export const REFUND_WINDOW_DAYS = 30;
export const REFUND_NETWORKS_READ = ["eip155:8453"] as const;

const BASE_PAYERS = new Set(BASE_PAYER_PERIODS.map((p) => p.address.toLowerCase()));
const MS_PER_DAY = 86_400_000;

export type RefundPurchase = {
  id: string;
  endpointId: string;
  host: string;
  status: string;
  network: string;
  payer: string;
  payTo: string;
  amountUnits: string;
  attemptedAt: string;
  httpStatusPaid: number | null;
  payloadNonEmpty?: boolean | null;
  /** 売り手ページの分類（classifySellerRow）で確定した売り手側か。 */
  sellerSide: boolean;
  txHash?: string | null;
};

export type RefundTransfer = {
  chain: string;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
  blockTime: string;
};

export type PayToRefund = {
  pay_to: string;
  /** この payTo に払った vet402 の Base の購入がある出品の数（ホストをまたぐ）。2 以上なら共有。 */
  listings_sharing: number;
  /** 分母に入れた売り手側の失敗の件数。 */
  failures_counted: number;
  /** 分母: その失敗で払った額の合計（基本単位）。 */
  paid_units: string;
  /** 分子: 戻った額の合計（paid_units で切る）。 */
  refunded_units: string;
  /** 切る前の戻った額の合計。 */
  refunded_units_raw: string;
  refund_rate: number | null;
  /** 戻った額に数えた送金の本数（paid で切った所まで・購入とは結びつけない）。 */
  refund_transfers: number;
  refund_txs: { tx_hash: string; amount_units: string; block_time: string }[];
  /** 30日の窓を読み終えていない売り手側の失敗（分母にも分子にも入れない）。 */
  failures_window_open: number;
};

export type RefundStats = {
  pay_tos: PayToRefund[];
  window_days: number;
  networks_read: readonly string[];
  read_through: string | null;
  /** Base 以外の網の売り手側の失敗（読んでいないので数えない）。 */
  failures_not_read: number;
};

function isBaseNetwork(network: string): boolean {
  const n = network.toLowerCase();
  return n === "eip155:8453" || n === "base";
}

/** payTo が運営者の番地か vet402 の Base の払う側の財布そのものなら true（数えない）。 */
export function isExcludedPayTo(payTo: string): boolean {
  const p = payTo.toLowerCase();
  return BASE_PAYERS.has(p) || isOperatorPayTo(p);
}

export function isBadPaid(p: RefundPurchase): boolean {
  if (p.status !== "settled") return false;
  if (isDelivered(p)) return false;
  if (
    isInconclusive({
      status: p.status,
      httpStatusPaid: p.httpStatusPaid,
      txHash: p.txHash ?? null,
      attemptedAt: p.attemptedAt,
      network: p.network,
    })
  )
    return false;
  if (p.httpStatusPaid === ACCEPTED_NOT_DONE_HTTP) return false;
  if (!BASE_PAYERS.has(p.payer.toLowerCase())) return false;
  return p.sellerSide === true;
}

function windowEndMs(attemptedAt: string): number {
  return Date.parse(attemptedAt) + REFUND_WINDOW_DAYS * MS_PER_DAY;
}

export function baseRefundWindowRead(readThrough: string | null, attemptedAt: string): boolean {
  if (readThrough === null) return false;
  return Date.parse(readThrough) >= windowEndMs(attemptedAt);
}

function units(s: string): bigint | null {
  try {
    const v = BigInt(s);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** 率は小数4桁。分母 0 は null。 */
function rateOf(back: bigint, paid: bigint): number | null {
  if (paid === 0n) return null;
  return Math.round(Number((back * 1_000_000n) / paid) / 100) / 10_000;
}

/**
 * payTo ごとの返金額。purchases は対象の payTo に払った購入（ホストをまたいで全部）、transfers はその payTo からの送金。
 * payTos を渡せば、その payTo だけを返す（頁のホストが払った payTo）。
 */
export function refundStats(
  purchases: RefundPurchase[],
  transfers: RefundTransfer[],
  readThrough: string | null,
  payTos?: readonly string[],
): RefundStats {
  const wanted = payTos ? new Set(payTos.map((p) => p.toLowerCase())) : null;
  const byPayTo = new Map<string, RefundPurchase[]>();
  let failures_not_read = 0;
  for (const p of purchases) {
    const payTo = p.payTo.toLowerCase();
    if (!payTo || isExcludedPayTo(payTo)) continue;
    if (wanted && !wanted.has(payTo)) continue;
    if (!isBaseNetwork(p.network)) {
      if (isBadPaid(p)) failures_not_read += 1;
      continue;
    }
    const list = byPayTo.get(payTo) ?? [];
    list.push(p);
    byPayTo.set(payTo, list);
  }

  const out: PayToRefund[] = [];
  for (const [payTo, list] of [...byPayTo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const listings = new Set(list.filter((p) => BASE_PAYERS.has(p.payer.toLowerCase())).map((p) => p.endpointId));
    const counted: RefundPurchase[] = [];
    let failures_window_open = 0;
    let paid = 0n;
    for (const p of list) {
      if (!isBadPaid(p)) continue;
      const amount = units(p.amountUnits);
      if (amount === null) continue;
      if (!baseRefundWindowRead(readThrough, p.attemptedAt)) {
        failures_window_open += 1;
        continue;
      }
      counted.push(p);
      paid += amount;
    }

    const seen = new Set<string>();
    const txs: PayToRefund["refund_txs"] = [];
    let backRaw = 0n;
    let listed = 0n;
    const sorted = [...transfers].sort((a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime) || a.txHash.localeCompare(b.txHash) || a.logIndex - b.logIndex);
    for (const t of sorted) {
      if (!isBaseNetwork(t.chain)) continue;
      if (t.from.toLowerCase() !== payTo) continue;
      if (!BASE_PAYERS.has(t.to.toLowerCase())) continue;
      const key = `${t.chain.toLowerCase()}:${t.txHash.toLowerCase()}:${t.logIndex}`;
      if (seen.has(key)) continue;
      const amount = units(t.amount);
      if (amount === null) continue;
      const tMs = Date.parse(t.blockTime);
      // 窓を読み終えた売り手側の失敗のどれかの後 30日以内に、同じ財布へ戻った送金だけ。
      // The receiving wallet may be either vet402 Base payer: a refund is not tied to the purchase that paid.
      const inWindow = counted.some((p) => tMs > Date.parse(p.attemptedAt) && tMs <= windowEndMs(p.attemptedAt));
      if (!inWindow) continue;
      seen.add(key);
      backRaw += amount;
      // The list stops where the sum reaches the amount paid, and the last transfer shows only the rest.
      const room = paid - listed;
      if (room > 0n) {
        const shown = amount > room ? room : amount;
        listed += shown;
        txs.push({ tx_hash: t.txHash, amount_units: shown.toString(), block_time: t.blockTime });
      }
    }
    const back = backRaw > paid ? paid : backRaw;
    out.push({
      pay_to: payTo,
      listings_sharing: listings.size,
      failures_counted: counted.length,
      paid_units: paid.toString(),
      refunded_units: back.toString(),
      refunded_units_raw: backRaw.toString(),
      refund_rate: rateOf(back, paid),
      refund_transfers: txs.length,
      refund_txs: txs,
      failures_window_open,
    });
  }

  return {
    pay_tos: out,
    window_days: REFUND_WINDOW_DAYS,
    networks_read: REFUND_NETWORKS_READ,
    read_through: readThrough,
    failures_not_read,
  };
}
