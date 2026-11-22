// ============================================================
// 届いた率の公開式（2026-11-22・計画 v3「Delivery Oracle」§5.1）。
//
// 単純な delivered / settled は 1/1 = 100% になり、1 回しか試していない売り手が上に出る。
// 95% Wilson スコアの下限を bps（0..10000、小数 2 桁の百分率）で返す。式は版番号で固定し、
// 変える時は版を上げる（同じ入力から誰でも同じ値を出し直せること）。
//   settled = delivered + settled_not_delivered（支払いがチェーンで確かめられた購入）。
//   settled が 0 なら下限は null（測っていない。0% とは違う）。
//   帯: settled < 5 は insufficient、5..29 は provisional、30 以上は established。
// ============================================================

import { wilsonLower } from "@/lib/find/rank";

export const DELIVERY_RATE_FORMULA = "v1.0-wilson95" as const;

export type DeliveryRateBand = "insufficient" | "provisional" | "established";

export type DeliveryRate = {
  lower_bps: number | null;
  band: DeliveryRateBand;
};

export function deliveryRateBand(settled: number): DeliveryRateBand {
  if (settled < 5) return "insufficient";
  if (settled < 30) return "provisional";
  return "established";
}

/** 95% Wilson 下限を bps の整数（切り捨て）で。delivered > settled や負の数は入力の誤りとして null。 */
export function wilsonLowerBps(delivered: number, settled: number): number | null {
  if (!Number.isInteger(delivered) || !Number.isInteger(settled)) return null;
  if (settled <= 0 || delivered < 0 || delivered > settled) return null;
  // find の順位と同じ式（z = 1.96）。分母は settled（find は署名した試行）。
  return Math.max(0, Math.floor(wilsonLower(delivered, settled) * 10_000 + 1e-9));
}

export function deliveryRate(delivered: number, settledNotDelivered: number): DeliveryRate {
  const settled = delivered + settledNotDelivered;
  return { lower_bps: wilsonLowerBps(delivered, settled), band: deliveryRateBand(settled) };
}
