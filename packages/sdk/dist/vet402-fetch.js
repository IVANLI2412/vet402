/**
 * createVet402Fetch: a fetch-shaped wrapper around pay().
 * No vet402 judgment or signing lives here. pay() owns all of that.
 */
import { pay } from "./pay.js";
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
export class Vet402RefusedError extends Error {
    result;
    constructor(result) {
        super(`vet402 refused: ${result.reasonCodes.join(", ") || result.status}`);
        this.name = "Vet402RefusedError";
        this.result = result;
    }
}
export class Vet402PayFailedError extends Error {
    result;
    constructor(result) {
        super(`vet402 pay failed: ${result.reasonCodes.join(", ") || result.status}`);
        this.name = "Vet402PayFailedError";
        this.result = result;
    }
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
function bytesToPayBody(buf) {
    if (buf.byteLength === 0)
        return undefined;
    return buf;
}
async function readRequestBody(req) {
    throwIfAborted(req.signal);
    if (req.body === null)
        return new Uint8Array(0);
    const reader = req.body.getReader();
    const chunks = [];
    let total = 0;
    const onAbort = () => {
        void reader.cancel(req.signal.reason);
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        for (;;) {
            throwIfAborted(req.signal);
            const { done, value } = await reader.read();
            if (done) {
                throwIfAborted(req.signal);
                break;
            }
            if (value !== undefined) {
                total += value.byteLength;
                if (total > MAX_REQUEST_BODY_BYTES) {
                    throw new Error("invalid_body: request body is larger than 10 MiB");
                }
                chunks.push(value);
            }
        }
    }
    catch (err) {
        if (req.signal?.aborted)
            throw req.signal.reason;
        throw err;
    }
    finally {
        req.signal?.removeEventListener("abort", onAbort);
        reader.releaseLock();
    }
    if (chunks.length === 0)
        return new Uint8Array(0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
async function toPayArgs(input, init) {
    const req = new Request(input, init);
    throwIfAborted(req.signal);
    const url = req.url;
    const method = req.method;
    const headers = new Headers(req.headers);
    let body;
    if (method !== "GET" && method !== "HEAD") {
        const buf = await readRequestBody(req);
        body = bytesToPayBody(buf);
    }
    const payInit = {
        method,
        headers,
        signal: req.signal,
        credentials: req.credentials,
        cache: req.cache,
        keepalive: req.keepalive,
        referrer: req.referrer,
        referrerPolicy: req.referrerPolicy,
        integrity: req.integrity,
        mode: req.mode,
        ...(body === undefined ? {} : { body }),
    };
    return { url, init: payInit };
}
/**
 * Returns a function with the same call shape as fetch. Each call runs pay() for that URL.
 * A 2xx Response means the seller answered after payment or asked for no payment. It does not
 * by itself prove the paid body arrived. Read pay()'s PayResult fields when that matters.
 */
export function createVet402Fetch(options) {
    return async (input, init) => {
        const { url, init: payInit } = await toPayArgs(input, init);
        const result = await pay(url, payInit, options);
        if (result.status === "paid" || result.status === "no_payment_required") {
            if (result.response === null)
                throw new Vet402PayFailedError(result);
            return result.response;
        }
        if (result.status === "refused")
            throw new Vet402RefusedError(result);
        throw new Vet402PayFailedError(result);
    };
}
