// ============================================================
// delivery の 3 値（2026-11-15・第 2 波 delivery）。
//
// x402-foundation/x402#3226 で議論された「買い手が見た物」の 3 値を、settled の行ごとに 1 つ決める。
//   delivered         settled かつ有料応答が 2xx（202 を除く）で本文が空でない。
//                     delivery.ts の isDelivered と同じ（l1.delivered と同じ数になる）。
//   no_body_observed  settled かつ有料応答が 5xx、または本文が空の 2xx（202 を除く）。
//                     observed_at の時点でそう見えた、という観測であって、売り手が届けないという所見ではない。
//   not_established   settled だが届いたかを言えない: HTTP の記録なし・202・3xx・決済後の 4xx（held_reason
//                     settled_4xx）・それ以外の値（1xx など）。理由を delivery_reason に残す。
//
// 母集団は settled の行だけ（金が動いたとチェーンで確かめた行）。和は l1.settled と同じになる。
// settled でない行はこの 3 値の外（null を返す）。境界の定数は delivery.ts から読むので、
// 2xx・202・4xx の境界がここと台帳で食い違うことはない。
// ============================================================
import {
  ACCEPTED_NOT_DONE_HTTP,
  heldReasonOf,
  INCONCLUSIVE_HTTP_MAX,
  INCONCLUSIVE_HTTP_MIN,
  isDelivered,
  isDeliveryHttp,
  SERVER_ERROR_HTTP_MAX,
  SERVER_ERROR_HTTP_MIN,
  type HeldReason,
} from "@/lib/observatory/delivery";

export const DELIVERY_VALUES = ["delivered", "no_body_observed", "not_established"] as const;
export type DeliveryValue = (typeof DELIVERY_VALUES)[number];

/** no_body_observed の理由。 */
export const NO_BODY_OBSERVED_REASONS = ["http_5xx", "empty_2xx"] as const;
/** not_established の理由。settled_4xx は delivery.ts の held_reason と同じ値。 */
export const NOT_ESTABLISHED_REASONS = ["no_http_status", "http_202", "http_3xx", "settled_4xx", "other_http"] as const;

export type DeliveryReason =
  | (typeof NO_BODY_OBSERVED_REASONS)[number]
  | (typeof NOT_ESTABLISHED_REASONS)[number];

export const REDIRECT_HTTP_MIN = 300;
export const REDIRECT_HTTP_MAX = 399;

export type DeliveryValueInput = {
  status: string;
  httpStatusPaid: number | null;
  payloadNonEmpty?: boolean | null;
};

export type DeliveryOutcome = { delivery: DeliveryValue; reason: DeliveryReason | null };

function inRange(code: number, min: number, max: number): boolean {
  return code >= min && code <= max;
}

/**
 * settled の行の 3 値と理由。settled でない行は null（3 値の外）。
 * delivered の判定は isDelivered をそのまま使う（本文の記録が無い 2xx は delivered に入る。l1.delivered と同じ）。
 */
export function deliveryOutcomeOf(row: DeliveryValueInput): DeliveryOutcome | null {
  if (row.status !== "settled") return null;
  if (isDelivered(row)) return { delivery: "delivered", reason: null };
  const code = row.httpStatusPaid;
  if (code === null || code === undefined) return { delivery: "not_established", reason: "no_http_status" };
  if (inRange(code, SERVER_ERROR_HTTP_MIN, SERVER_ERROR_HTTP_MAX)) return { delivery: "no_body_observed", reason: "http_5xx" };
  // isDelivered が false で isDeliveryHttp が true なら、残る理由は本文が空と記録されたことだけ。
  if (isDeliveryHttp(code)) return { delivery: "no_body_observed", reason: "empty_2xx" };
  if (code === ACCEPTED_NOT_DONE_HTTP) return { delivery: "not_established", reason: "http_202" };
  if (inRange(code, REDIRECT_HTTP_MIN, REDIRECT_HTTP_MAX)) return { delivery: "not_established", reason: "http_3xx" };
  if (inRange(code, INCONCLUSIVE_HTTP_MIN, INCONCLUSIVE_HTTP_MAX)) {
    // settled の 4xx は held_reason が settled_4xx（delivery.ts）。理由の語をそこから取る。
    const held: HeldReason | null = heldReasonOf({
      status: row.status,
      httpStatusPaid: code,
      txHash: null,
      attemptedAt: null,
      network: null,
    });
    return { delivery: "not_established", reason: held === "settled_4xx" ? "settled_4xx" : "other_http" };
  }
  return { delivery: "not_established", reason: "other_http" };
}

/** 3 値の件数（settled でない行は数えない）。和は settled の行数。 */
export function countDeliveryValues(rows: readonly DeliveryValueInput[]): Record<DeliveryValue, number> {
  const out: Record<DeliveryValue, number> = { delivered: 0, no_body_observed: 0, not_established: 0 };
  for (const r of rows) {
    const o = deliveryOutcomeOf(r);
    if (o) out[o.delivery] += 1;
  }
  return out;
}

/**
 * 3 値の定義の英文（公開文）。/docs/api・methodology・CSV の x-vet402-column-notes がこの 1 か所を読む。
 * we/our/us・ダッシュ・セミコロンを置かない（第 1 波の英語の決まり）。
 */
export const DELIVERY_VALUE_DEFINITIONS: Readonly<Record<DeliveryValue, string>> = {
  delivered:
    "delivered: the payment settled and the paid request answered HTTP 2xx other than 202 Accepted, with a non-empty body. A 2xx whose body was not recorded counts here, and only a body recorded as empty is left out. This is the same rule as l1.delivered.",
  no_body_observed:
    "no_body_observed: the payment settled and the paid request answered 5xx, or 2xx other than 202 with a body recorded as empty or not read to the end (delivery_reason http_5xx or empty_2xx). It is what vet402 saw on that attempt, not a finding that the seller never delivers.",
  not_established:
    "not_established: the payment settled and the answer cannot show delivery either way. No HTTP status on record (no_http_status), 202 Accepted (http_202), a 3xx (http_3xx), a 4xx after settlement (settled_4xx, the same as held_reason), or any other status such as a 1xx (other_http). delivery_reason names which.",
};

/** 定義の出所の書き方（約束・採用済みとは書かない）。 */
export const DELIVERY_VALUES_SOURCE_NOTE = "the definition discussed in x402-foundation/x402#3226";
