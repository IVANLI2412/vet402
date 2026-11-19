/**
 * pay(url, init, { account }): check an x402 seller with vet402, then pay it.
 *
 * This file adds no second judgment. Every decision to sign stays in payOrRefuse. pay() only reads
 * the seller's unpaid 402 so the caller does not have to supply payTo and price, then hands those
 * values to payOrRefuse, which reads the 402 again and refuses when they no longer match.
 *
 * Default: only ALLOW pays. WARN needs allowWarn. A URL vet402 has no record of needs allowUnknown.
 */
import { CHAIN_PROFILES } from "./chain-profile.js";
import { DEFAULT_API_URL, DEFAULT_REQUEST_TIMEOUT_MS } from "./index.js";
import { DEFAULT_MAX_PER_TX_USD, payOrRefuse, } from "./pay-or-refuse.js";
const USDC_UNITS = 1_000_000;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const AMOUNT_RE = /^[1-9][0-9]*$/;
const PAYMENT_HEADERS = ["payment-signature", "x-payment"];
/** Reject when `signal` aborts even if the underlying fetch ignores `signal`. */
function raceAbort(promise, signal) {
    if (signal?.aborted) {
        // The fetch already started, so its own rejection must not go unhandled (it would crash Node).
        promise.catch(() => undefined);
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    if (signal == null)
        return promise;
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort);
        promise.then((value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        }, (reason) => {
            signal.removeEventListener("abort", onAbort);
            reject(reason);
        });
    });
}
function refused(reason, recommendation = null) {
    return { status: "refused", response: null, recommendation, reasonCodes: [reason], signed: false, txHash: null, receipt: null };
}
function assertReplayableBody(body) {
    const ok = body === undefined ||
        body === null ||
        typeof body === "string" ||
        body instanceof URLSearchParams ||
        body instanceof ArrayBuffer ||
        ArrayBuffer.isView(body);
    if (!ok)
        throw new Error("invalid_body: pass a string, URLSearchParams or bytes, because the request is sent more than once");
}
/** The first payable USDC offer on this chain, in the seller's order. Null when none can be read. */
function readOffer(response, network) {
    const raw = response.headers.get("payment-required");
    if (!raw)
        return null;
    const profile = CHAIN_PROFILES[network];
    try {
        const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
        if (!Array.isArray(parsed.accepts))
            return null;
        for (const item of parsed.accepts) {
            if (typeof item !== "object" || item === null)
                continue;
            const accept = item;
            const amount = accept.amount ?? accept.maxAmountRequired;
            if (accept.scheme !== "exact")
                continue;
            if (accept.network !== profile.network && accept.network !== profile.v1Slug)
                continue;
            if (typeof accept.asset !== "string" || accept.asset.toLowerCase() !== profile.asset.toLowerCase())
                continue;
            const extra = accept.extra;
            if (extra?.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009")
                continue;
            if (typeof accept.payTo !== "string" || !WALLET_RE.test(accept.payTo))
                continue;
            if (typeof amount !== "string" || !AMOUNT_RE.test(amount))
                continue;
            return { payTo: accept.payTo, amountUsd: Number(amount) / USDC_UNITS };
        }
        return null;
    }
    catch {
        return null;
    }
}
export async function pay(url, init, options) {
    if (typeof url !== "string" && !(url instanceof URL)) {
        throw new Error("invalid_url: pass the URL as a string or URL, and put the method, headers and body in init");
    }
    const resource = String(url);
    if (new URL(resource).protocol !== "https:")
        throw new Error("invalid_url: the seller URL must use https");
    if (!options || options.account === undefined || options.account === null)
        throw new Error("invalid_payer: pass account");
    const maxUsd = options.maxUsd ?? DEFAULT_MAX_PER_TX_USD;
    if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0)
        throw new Error("invalid_max_usd: pass a positive number");
    const network = options.network ?? "base";
    if (!Object.hasOwn(CHAIN_PROFILES, network))
        throw new Error("invalid_network");
    assertReplayableBody(init?.body);
    const method = (init?.method ?? "GET").toUpperCase();
    const baseFetch = options.fetch ?? globalThis.fetch;
    const apiBase = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    let sellerAnswer = null;
    // Every request to the seller carries the caller's method, headers and body. A URL with no record
    // can only pass through the payee score, so that read is closed unless the caller allowed it.
    const attestTimeoutSignal = () => {
        const timeout = AbortSignal.timeout;
        return typeof timeout === "function" ? timeout(DEFAULT_REQUEST_TIMEOUT_MS) : undefined;
    };
    const guardedFetch = async (input, callInit) => {
        const target = input instanceof Request ? input.url : String(input);
        const signal = callInit?.signal ?? init?.signal ?? undefined;
        const callMethod = (callInit?.method ?? "GET").toUpperCase();
        const isAttestPost = target === `${apiBase}/payments/x402` && callMethod === "POST";
        if (target.startsWith(`${apiBase}/payees/`) && options.allowUnknown !== true) {
            throw new Error("unknown_seller_not_allowed");
        }
        if (target !== resource) {
            if (isAttestPost) {
                const attestSignal = attestTimeoutSignal();
                return baseFetch(input, { ...callInit, signal: attestSignal });
            }
            if (signal?.aborted)
                throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
            return raceAbort(baseFetch(input, { ...callInit, signal }), signal);
        }
        const headers = new Headers(init?.headers);
        for (const k of PAYMENT_HEADERS)
            headers.delete(k);
        const extra = new Headers(callInit?.headers);
        for (const k of PAYMENT_HEADERS) {
            const v = extra.get(k);
            if (v !== null)
                headers.set(k, v);
        }
        // A redirect could carry the signed payment to a host nobody checked, so it is never followed.
        if (signal?.aborted)
            throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        const answer = await raceAbort(baseFetch(resource, { ...init, ...callInit, method, headers, body: init?.body, redirect: "error", signal }), signal);
        if (headers.has("payment-signature") || headers.has("x-payment"))
            sellerAnswer = answer.clone();
        return answer;
    };
    let first;
    try {
        first = await guardedFetch(resource);
    }
    catch {
        return refused("seller_unreachable");
    }
    if (first.status !== 402) {
        if (first.ok) {
            return { status: "no_payment_required", response: first, recommendation: null, reasonCodes: [], signed: false, txHash: null, receipt: null };
        }
        return refused("no_payment_request");
    }
    const offer = readOffer(first, network);
    if (offer === null)
        return refused("no_eligible_accept");
    if (offer.amountUsd > maxUsd)
        return refused("price_above_ceiling");
    const policy = options.allowWarn === true
        ? { maxPerTxUsd: maxUsd, requireVet402Allow: false, evidence: { minL1Deliveries: 1 } }
        : { maxPerTxUsd: maxUsd };
    const result = await payOrRefuse({
        payee: offer.payTo,
        resource,
        amountUsd: offer.amountUsd,
        method,
        network,
        fetch: guardedFetch,
        account: options.account,
        policy,
        source: "sdk-pay",
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        ...(options.decisionStore === undefined ? {} : { decisionStore: options.decisionStore }),
    });
    return {
        status: result.status,
        response: result.status === "refused" ? null : sellerAnswer,
        recommendation: typeof result.decision.decision?.recommendation === "string" ? result.decision.decision.recommendation : null,
        reasonCodes: result.decision.reason_codes,
        signed: result.signed,
        txHash: result.txHash,
        receipt: result.receipt ?? null,
    };
}
