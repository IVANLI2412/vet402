/**
 * pay(url, init, { account }): check an x402 seller with vet402, then pay it.
 *
 * This file adds no second judgment. Every decision to sign stays in payOrRefuse. pay() only reads
 * the seller's unpaid 402 so the caller does not have to supply payTo and price, then hands those
 * values to payOrRefuse, which reads the 402 again and refuses when they no longer match.
 *
 * Default: only ALLOW pays. WARN needs allowWarn. A URL vet402 has no record of needs allowUnknown.
 */
import { type ChainProfileName } from "./chain-profile.js";
import { type PayReceipt, type PayerAccount } from "./pay-or-refuse.js";
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
