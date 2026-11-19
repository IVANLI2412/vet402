/**
 * createVet402Fetch: a fetch-shaped wrapper around pay().
 * No vet402 judgment or signing lives here. pay() owns all of that.
 */
import { pay } from "./pay.js";
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
async function toPayArgs(input, init) {
    if (typeof input === "string" || input instanceof URL) {
        return { url: String(input), init };
    }
    assertReplayableBody(init?.body);
    const req = new Request(input, init);
    const url = req.url;
    const method = req.method;
    const headers = new Headers(req.headers);
    let body;
    if (method !== "GET" && method !== "HEAD") {
        // A built Request always exposes body as a stream; materializing bytes is how pay() replays (unlike FormData in init to pay(), which assertReplayableBody rejects above).
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 0)
            body = new Uint8Array(buf);
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
