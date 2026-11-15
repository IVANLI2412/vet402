// ============================================================
// P2 争いの端の書き込み上限（UTC 日次・取引ごと履歴）。
// ============================================================
import type { TradeDisputeLegRow } from "@/lib/observatory/trade-dispute-store";

export let writeLimitPerWallet = 20;
export let writeLimitPerTradeSide = 10;

export function setTradeDisputeWriteLimitsForTests(
  perWallet: number | null,
  perTradeSide: number | null,
): void {
  if (perWallet !== null) writeLimitPerWallet = perWallet;
  if (perTradeSide !== null) writeLimitPerTradeSide = perTradeSide;
}

export function resetTradeDisputeWriteLimitsForTests(): void {
  writeLimitPerWallet = 20;
  writeLimitPerTradeSide = 10;
}

export function signingWalletForLeg(row: Pick<TradeDisputeLegRow, "signer">): string {
  return row.signer.toLowerCase();
}

export function utcDayOfIso(iso: string): string {
  return iso.slice(0, 10);
}

export function countWritesForLimit(
  rows: readonly TradeDisputeLegRow[],
  wallet: string,
  utcDay: string,
): number {
  let walletCount = 0;
  const w = wallet.toLowerCase();
  for (const r of rows) {
    const day = utcDayOfIso(r.acceptedAt);
    if (day !== utcDay) continue;
    if (signingWalletForLeg(r) === w) walletCount++;
  }
  return walletCount;
}

export function countLegsForTradeSide(
  rows: readonly TradeDisputeLegRow[],
  tradeId: string,
  side: "payer" | "seller",
): number {
  const id = tradeId.toLowerCase();
  let n = 0;
  for (const r of rows) {
    if (r.tradeId.toLowerCase() === id && r.side === side) n++;
  }
  return n;
}

export function writeLimitExceeded(
  rows: readonly TradeDisputeLegRow[],
  wallet: string,
  acceptedAtIso: string,
): boolean {
  const day = utcDayOfIso(acceptedAtIso);
  const walletCount = countWritesForLimit(rows, wallet, day);
  return walletCount >= writeLimitPerWallet;
}

export function tradeSideHistoryLimitExceeded(
  rows: readonly TradeDisputeLegRow[],
  tradeId: string,
  side: "payer" | "seller",
): boolean {
  return countLegsForTradeSide(rows, tradeId, side) >= writeLimitPerTradeSide;
}