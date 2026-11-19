/**
 * createVet402Fetch: a fetch-shaped wrapper around pay().
 * No vet402 judgment or signing lives here. pay() owns all of that.
 */
import { pay, type PayOptions, type PayResult } from "./pay.js";

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export class Vet402RefusedError extends Error {
  readonly result: PayResult;

  constructor(result: PayResult) {
    super(`vet402 refused: ${result.reasonCodes.join(", ") || result.status}`);
    this.name = "Vet402RefusedError";
    this.result = result;
  }
}

export class Vet402PayFailedError extends Error {
  readonly result: PayResult;

  constructor(result: PayResult) {
    super(`vet402 pay failed: ${result.reasonCodes.join(", ") || result.status}`);
    this.name = "Vet402PayFailedError";
    this.result = result;
  }
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** Caller signal: init.signal wins over a Request input signal, same as fetch. */
function resolveCallerSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function bytesToPayBody(buf: Uint8Array): BodyInit {
  return buf as unknown as BodyInit;
}

function rejectAbortedWithPayResult(signal: AbortSignal, result: PayResult): never {
  const reason = signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  if (reason instanceof Error) {
    Object.defineProperty(reason, "vet402PayResult", { value: result, configurable: true, enumerable: true });
    throw reason;
  }
  const err = new DOMException("The operation was aborted", "AbortError");
  Object.defineProperty(err, "vet402PayResult", { value: result, configurable: true, enumerable: true });
  throw err;
}

async function readRequestBody(signal: AbortSignal | undefined, req: Request): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(signal!.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        throwIfAborted(signal);
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_REQUEST_BODY_BYTES) {
          const limitErr = new Error("invalid_body: request body is larger than 10 MiB");
          await reader.cancel(limitErr);
          throw limitErr;
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (chunks.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function toPayArgs(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; init: RequestInit | undefined }> {
  const callerSignal = resolveCallerSignal(input, init);
  const req = new Request(input, init);
  throwIfAborted(callerSignal);
  const url = req.url;
  const method = req.method;
  const headers = new Headers(req.headers);
  let body: RequestInit["body"] | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const buf = await readRequestBody(callerSignal, req);
    body = bytesToPayBody(buf);
  }
  const payInit: RequestInit = {
    method,
    headers,
    signal: callerSignal,
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
export function createVet402Fetch(options: PayOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const callerSignal = resolveCallerSignal(input, init);
    const { url, init: payInit } = await toPayArgs(input, init);
    const result = await pay(url, payInit, options);
    if (callerSignal?.aborted && result.status === "refused") rejectAbortedWithPayResult(callerSignal, result);
    if (result.status === "paid" || result.status === "no_payment_required") {
      if (result.response === null) throw new Vet402PayFailedError(result);
      return result.response;
    }
    if (result.status === "refused") throw new Vet402RefusedError(result);
    throw new Vet402PayFailedError(result);
  };
}