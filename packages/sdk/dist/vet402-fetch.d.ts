/**
 * createVet402Fetch: a fetch-shaped wrapper around pay().
 * No vet402 judgment or signing lives here. pay() owns all of that.
 */
import { type PayOptions, type PayResult } from "./pay.js";
export declare class Vet402RefusedError extends Error {
    readonly result: PayResult;
    constructor(result: PayResult);
}
export declare class Vet402PayFailedError extends Error {
    readonly result: PayResult;
    constructor(result: PayResult);
}
/**
 * Returns a function with the same call shape as fetch. Each call runs pay() for that URL.
 * A 2xx Response means the seller answered after payment or asked for no payment. It does not
 * by itself prove the paid body arrived. Read pay()'s PayResult fields when that matters.
 */
export declare function createVet402Fetch(options: PayOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
