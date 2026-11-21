/** Paid seller wait is capped at the EIP-3009 authorization window (same as @vet402/sdk). */
export declare const MAX_PAID_SELLER_WAIT_MS = 120000;
/** vet402 API ルートの origin（boundedFetch の照合に使う）。 */
export declare function originOfVet402ApiRoot(apiRoot: string): string;
/** vet402 へだけ AbortSignal.timeout を付ける fetch。 */
export declare function vet402BoundedFetch(apiRoot: string, timeoutMs: number, baseFetch?: typeof fetch): typeof fetch;
/** validBefore (unix seconds) from a signed PAYMENT-SIGNATURE / X-PAYMENT header, if readable. */
export declare function validBeforeSecFromPaymentHeaders(headers: Headers): number | null;
/** Wall-clock wait until validBefore, capped at {@link MAX_PAID_SELLER_WAIT_MS}. */
export declare function paidSellerWaitMs(validBeforeSec: number | null, nowMs: number): number;
/**
 * vet402 API reads use `vet402TimeoutMs`. Paid seller retries wait until the signed
 * authorization's validBefore (capped at 120 s) so a silent seller cannot hang the tool call.
 */
export declare function createMcpBoundedFetch(apiRoot: string, vet402TimeoutMs: number, baseFetch?: typeof fetch, nowMs?: () => number): typeof fetch;
