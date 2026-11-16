// ============================================================
// L1 の待ち時間（2026-09-29）。l1-runner（支払いのコード）と公開の方法論頁の両方が読むので、
// 依存の無いこのファイルに置く（公開頁に支払いのモジュールを読み込ませない）。
// chains.ts の CAIP-2 だけは読んでよい（正本はここに複製しない）。
// ============================================================

import { XRPL_MAINNET_CAIP2 } from "./chains";

/**
 * 1 本の HTTP（無払いの要求・支払い付きの要求それぞれ）を待つ上限（既定）。本文の読み取りを含む。
 * 支払い付きの要求の後にチェーンでの着金を待つことはしない（着金の確認は非同期: 遅延回収と照合器）。
 */
export const L1_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Celo（eip155:42220）の支払い付きの要求だけ待つ上限（2026-10-18）。
 * x402-rs の facilitator は receipt の後に成功を返す。Celo の送金は要求から 16〜24 秒で
 * ブロックに入っていたので、20 秒で切ると届いた呼び出しが応答なしになる。
 * 無払いの要求と、ほかのチェーンの支払い付き要求は L1_REQUEST_TIMEOUT_MS のまま。
 * 文字列は x402-payer.ts の CELO_CAIP2 と同じ。支払いのモジュールは import しない
 * （このファイルは公開の方法論頁も読む）。
 */
export const L1_CELO_PAID_TIMEOUT_MS = 45_000;
export const L1_CELO_NETWORK = "eip155:42220";

/**
 * Arbitrum One（eip155:42161）の支払い付きの要求は既定の L1_REQUEST_TIMEOUT_MS（2026-10-22）。
 * Celo だけ facilitator が receipt の後に返すので 45 秒。Arbitrum はその実測が無いので広げない。
 * 文字列は x402-payer.ts の ARBITRUM_CAIP2 と同じ。支払いのモジュールは import しない。
 */
export const L1_ARBITRUM_NETWORK = "eip155:42161";

/**
 * Avalanche C-Chain（eip155:43114）の支払い付きの要求は既定の L1_REQUEST_TIMEOUT_MS（2026-10-26）。
 * Celo だけ facilitator が receipt の後に返すので 45 秒。Avalanche はその実測が無いので広げない。
 * 文字列は x402-payer.ts の AVALANCHE_CAIP2 と同じ。支払いのモジュールは import しない。
 */
export const L1_AVALANCHE_NETWORK = "eip155:43114";

/**
 * 方法論の頁が「Celo の支払い付きは 45 秒」と書く開始日。
 * 45 秒の待ち自体は 2026-10-18 からランナーにある。行に `paidTimeoutMs` を残し始めたのはこの日で、
 * それより前の行（記録が無い行）は分類でも公開文でも 20 秒として扱う。
 */
export const L1_CELO_PAID_TIMEOUT_SINCE = "2026-10-19";

/**
 * XRPL（xrpl:0）の支払い付きの要求だけ待つ上限（2026-11-16）。
 * 実測では api.vextorium.com/v1/filing-summary が約 21 秒で 200 を返し、vet402 の支払い付き行は
 * HTTP 応答なしになった。決済の確定は中央値 6.7 秒だが、売り手が ledger 確定まで応答を持つと
 * 20 秒では切れる。無払いの要求と、ほかのチェーンの支払い付き要求は L1_REQUEST_TIMEOUT_MS のまま。
 * 文字列は chains.ts の XRPL_MAINNET_CAIP2 と同じ。testnet（xrpl:1 等）は含めない。
 */
export const L1_XRPL_PAID_TIMEOUT_MS = 45_000;
export const L1_XRPL_NETWORK = XRPL_MAINNET_CAIP2;

/**
 * 方法論の頁が「XRPL の支払い付きは 45 秒」と書く開始日。
 * 行に `paidTimeoutMs` を残し始めたのは 2026-10-19（Celo と同じ）で、
 * それより前の行は分類でも公開文でも 20 秒として扱う。
 */
export const L1_XRPL_PAID_TIMEOUT_SINCE = "2026-11-16";

/**
 * 支払い付きの要求を待つミリ秒。network が Celo または XRPL mainnet のときだけ 45 秒。
 * Arbitrum（L1_ARBITRUM_NETWORK）と Avalanche（L1_AVALANCHE_NETWORK）は既定の timeoutMs。
 * timeoutMs / celoPaidTimeoutMs / xrplPaidTimeoutMs はテストの差し込み（本番は定数）。
 */
export function l1PaidTimeoutMs(
  network: string | null | undefined,
  options: { timeoutMs?: number; celoPaidTimeoutMs?: number; xrplPaidTimeoutMs?: number } = {},
): number {
  const timeoutMs = options.timeoutMs ?? L1_REQUEST_TIMEOUT_MS;
  if (network === L1_CELO_NETWORK) return options.celoPaidTimeoutMs ?? L1_CELO_PAID_TIMEOUT_MS;
  if (network === L1_XRPL_NETWORK) return options.xrplPaidTimeoutMs ?? L1_XRPL_PAID_TIMEOUT_MS;
  if (network === L1_ARBITRUM_NETWORK) return timeoutMs;
  if (network === L1_AVALANCHE_NETWORK) return timeoutMs;
  return timeoutMs;
}
