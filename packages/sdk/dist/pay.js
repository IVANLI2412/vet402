/**
 * pay(url, init, { account }): check an x402 seller with vet402, then pay it.
 *
 * This file adds no second judgment. Every decision to sign stays in payOrRefuse. pay() only reads
 * the seller's unpaid 402 so the caller does not have to supply payTo and price, then hands those
 * values to payOrRefuse, which reads the 402 again and refuses when they no longer match.
 *
 * Transport: vet402 reads stop on {@link PayOptions.requestTimeoutMs} and caller abort. Unpaid seller
 * probes wait only for headers within that limit and close the connection when headers time out.
 * After payment is sent the seller request is not cut off. The call waits for headers up to
 * {@link PayOptions.paidResponseTimeoutMs} or caller abort, then returns failed with signed and nonce
 * if headers never arrived. Response bodies still complete once headers land.
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
/** Default wall-clock limit for paid seller response headers after a payment is sent. */
export const DEFAULT_PAID_RESPONSE_TIMEOUT_MS = 120_000;
function assertBoundedTimeoutMs(ms, code) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 1 || ms > 2_147_483_647 || Math.trunc(ms) !== ms) {
        throw new Error(`${code}: pass an integer from 1 through 2147483647`);
    }
    return ms;
}
function operationTimedOut() {
    return new DOMException("The operation timed out", "TimeoutError");
}
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
    const requestTimeoutMs = assertBoundedTimeoutMs(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "invalid_request_timeout_ms");
    const paidResponseTimeoutMs = assertBoundedTimeoutMs(options.paidResponseTimeoutMs ?? DEFAULT_PAID_RESPONSE_TIMEOUT_MS, "invalid_paid_response_timeout_ms");
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
    const timeoutSignal = (ms = requestTimeoutMs) => {
        const timeout = AbortSignal.timeout;
        return typeof timeout === "function" ? timeout(ms) : undefined;
    };
    const combineAbortSignals = (signals) => {
        const live = signals.filter((s) => s !== undefined);
        if (live.length === 0)
            return undefined;
        if (live.length === 1)
            return live[0];
        const any = AbortSignal.any;
        if (typeof any === "function")
            return any(live);
        const controller = new AbortController();
        const onAbort = () => {
            for (const s of live)
                s.removeEventListener("abort", onAbort);
            const aborted = live.find((s) => s.aborted);
            controller.abort(aborted?.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        for (const s of live) {
            if (s.aborted) {
                onAbort();
                break;
            }
            s.addEventListener("abort", onAbort, { once: true });
        }
        return controller.signal;
    };
    const vet402ReadSignal = (caller) => {
        const timed = timeoutSignal();
        if (caller === undefined)
            return timed;
        if (timed === undefined)
            return caller;
        return combineAbortSignals([caller, timed]);
    };
    /** Close the transport on header timeout while still allowing the response body to finish once headers land. */
    const headerCloseGate = (caller, ms) => {
        const controller = new AbortController();
        let timer = setTimeout(() => {
            controller.abort(operationTimedOut());
        }, ms);
        const fetchParts = [controller.signal];
        if (caller !== undefined)
            fetchParts.push(caller);
        const stopTimer = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        };
        const closeTransport = () => {
            stopTimer();
            if (!controller.signal.aborted)
                controller.abort(operationTimedOut());
        };
        return {
            fetchSignal: combineAbortSignals(fetchParts),
            waitSignal: vet402ReadSignal(caller),
            onHeaders: stopTimer,
            closeTransport,
        };
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
                const gate = headerCloseGate(undefined, requestTimeoutMs);
                try {
                    const attestInit = { ...callInit, signal: gate.fetchSignal };
                    const res = await raceAbort(baseFetch(input, attestInit), gate.waitSignal);
                    // Stop the header timer once the answer is in, or it keeps the process alive for requestTimeoutMs.
                    gate.onHeaders();
                    return res;
                }
                catch (err) {
                    gate.closeTransport();
                    throw err;
                }
            }
            const gate = headerCloseGate(signal, requestTimeoutMs);
            if (gate.waitSignal?.aborted)
                throw gate.waitSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
            try {
                const res = await raceAbort(baseFetch(input, { ...callInit, signal: gate.fetchSignal }), gate.waitSignal);
                gate.onHeaders();
                const body = await raceAbort(res.arrayBuffer(), gate.waitSignal);
                return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
            }
            catch (err) {
                gate.closeTransport();
                throw err;
            }
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
        const isPaid = headers.has("payment-signature") || headers.has("x-payment");
        // A redirect could carry the signed payment to a host nobody checked, so it is never followed.
        // An abort that lands before the paid request leaves stops it. Once it has left, it is not cut (below).
        if (signal?.aborted)
            throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        if (isPaid) {
            const paidFetchInit = { ...init, ...callInit, method, headers, body: init?.body, redirect: "error" };
            delete paidFetchInit.signal;
            const paidWaitParts = [];
            const paidTimed = timeoutSignal(paidResponseTimeoutMs);
            if (paidTimed !== undefined)
                paidWaitParts.push(paidTimed);
            if (signal !== undefined)
                paidWaitParts.push(signal);
            const paidWaitSignal = paidWaitParts.length === 0 ? undefined : paidWaitParts.length === 1 ? paidWaitParts[0] : combineAbortSignals(paidWaitParts);
            const paidFlight = baseFetch(resource, paidFetchInit);
            try {
                const answer = await raceAbort(paidFlight, paidWaitSignal);
                sellerAnswer = answer.clone();
                return answer;
            }
            catch (err) {
                paidFlight.catch(() => undefined);
                throw err;
            }
        }
        const gate = headerCloseGate(signal, requestTimeoutMs);
        if (gate.waitSignal?.aborted)
            throw gate.waitSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
        const unpaidFetchInit = {
            ...init,
            ...callInit,
            method,
            headers,
            body: init?.body,
            redirect: "error",
            signal: gate.fetchSignal,
        };
        try {
            const answer = await raceAbort(baseFetch(resource, unpaidFetchInit), gate.waitSignal);
            gate.onHeaders();
            if (answer.status === 402) {
                // Only the payment-required header of a 402 is read. Drop its body so a seller that never ends it
                // cannot hold the connection open.
                await answer.body?.cancel().catch(() => undefined);
                return new Response(null, { status: 402, statusText: answer.statusText, headers: answer.headers });
            }
            return answer;
        }
        catch (err) {
            gate.closeTransport();
            throw err;
        }
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
