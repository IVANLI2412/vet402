/**
 * createVet402Fetch: a fetch-shaped wrapper around pay().
 * No vet402 judgment or signing lives here. pay() owns all of that.
 */
import { pay, type PayOptions, type PayResult } from "./pay.js";

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

async function toPayArgs(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; init: RequestInit | undefined }> {
  if (typeof input === "string" || input instanceof URL) {
    return { url: String(input), init };
  }
  const req = new Request(input, init);
  const url = req.url;
  const method = req.method;
  const headers = new Headers(req.headers);
  let body: RequestInit["body"] | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const text = await req.text();
    if (text.length > 0) body = text;
  }
  return { url, init: { method, headers, ...(body === undefined ? {} : { body }) } };
}

/**
 * Returns a function with the same call shape as fetch. Each call runs pay() for that URL.
 * A 2xx Response means the seller answered after payment or asked for no payment. It does not
 * by itself prove the paid body arrived. Read pay()'s PayResult fields when that matters.
 */
export function createVet402Fetch(options: PayOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const { url, init: payInit } = await toPayArgs(input, init);
    const result = await pay(url, payInit, options);
    if (result.status === "paid" || result.status === "no_payment_required") {
      if (result.response === null) throw new Error("vet402_fetch: pay returned no response for a success status");
      return result.response;
    }
    if (result.status === "refused") throw new Vet402RefusedError(result);
    throw new Vet402PayFailedError(result);
  };
}