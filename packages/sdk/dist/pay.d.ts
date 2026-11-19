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
import { type ChainProfileName } from "./chain-profile.js";
import { type PayReceipt, type PayerAccount } from "./pay-or-refuse.js";
/** Default wall-clock limit for paid seller response headers after a payment is sent. */
export declare const DEFAULT_PAID_RESPONSE_TIMEOUT_MS = 120000;
export type PayOptions = {
    /** EIP-3009 signer. vet402 never holds it. */
    account: PayerAccount;
    /** Largest price this call may pay, in USD. Default 1. */
    maxUsd?: number;
    /** Chain to pay on. Default "base". */
    network?: ChainProfileName;
    /** Pay a WARN seller when vet402 has recorded at least one delivery from it. Default false. */
    allowWarn?: boolean;
    /** Pay a URL vet402 has no record of when the payee score passes. Default false. */
    allowUnknown?: boolean;
    apiKey?: string;
    apiUrl?: string;
    /** Default: the global fetch. */
    fetch?: typeof fetch;
    /** JSONL path for decision rows. Nothing is written unless this is set. */
    decisionStore?: string;
    /** Wall-clock limit for vet402 reads and unpaid seller probes. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
    requestTimeoutMs?: number;
    /**
     * Wall-clock limit for waiting on paid seller response headers after payment is sent.
     * Default {@link DEFAULT_PAID_RESPONSE_TIMEOUT_MS}. Does not cut off the request once headers arrive.
     */
    paidResponseTimeoutMs?: number;
};
export type PayStatus = "paid" | "refused" | "failed" | "no_payment_required";
export type PayResult = {
    /**
     * "paid": the seller confirmed settlement with a transaction id and a 2xx answer other than 202. "refused": nothing was signed.
     * "failed": a payment may exist, so read `receipt` before trying again. This includes a seller that said
     * success but named no transaction, or answered 202 or a non-2xx status (reason code `settle_unconfirmed`).
     * "no_payment_required": the seller answered without asking for payment.
     */
    status: PayStatus;
    /** The seller's answer. Null when no answer is available. */
    response: Response | null;
    /** vet402's verdict for this URL. Null when vet402 returned none. */
    recommendation: string | null;
    reasonCodes: string[];
    /** True when a payment authorization was signed. */
    signed: boolean;
    txHash: string | null;
    receipt: PayReceipt | null;
};
export declare function pay(url: string | URL, init: RequestInit | undefined, options: PayOptions): Promise<PayResult>;
