/**
 * pay(url, init, { account }): check an x402 seller with vet402, then pay it.
 *
 * This file adds no second judgment. Every decision to sign stays in payOrRefuse. pay() only reads
 * the seller's unpaid 402 so the caller does not have to supply payTo and price, then hands those
 * values to payOrRefuse, which reads the 402 again and refuses when they no longer match.
 *
 * Default: only ALLOW pays. WARN needs allowWarn. A URL vet402 has no record of needs allowUnknown.
 */
import { CHAIN_PROFILES, type ChainProfileName } from "./chain-profile.js";
import { DEFAULT_API_URL } from "./index.js";
import {
  DEFAULT_MAX_PER_TX_USD,
  payOrRefuse,
  type PayOrRefuseResult,
  type PayPolicy,
  type PayReceipt,
  type PayerAccount,
} from "./pay-or-refuse.js";

const USDC_UNITS = 1_000_000;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const AMOUNT_RE = /^[1-9][0-9]*$/;

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
};

export type PayStatus = "paid" | "refused" | "failed" | "no_payment_required";

export type PayResult = {
  /**
   * "paid": the seller confirmed settlement. "refused": nothing was signed.
   * "failed": a payment may exist, so read `receipt` before trying again.
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

type Offer = { payTo: string; amountUsd: number };

function refused(reason: string, recommendation: string | null = null): PayResult {
  return { status: "refused", response: null, recommendation, reasonCodes: [reason], signed: false, txHash: null, receipt: null };
}

function assertReplayableBody(body: unknown): void {
  const ok =
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body);
  if (!ok) throw new Error("invalid_body: pass a string, URLSearchParams or bytes, because the request is sent more than once");
}

/** The first payable USDC offer on this chain, in the seller's order. Null when none can be read. */
function readOffer(response: Response, network: ChainProfileName): Offer | null {
  const raw = response.headers.get("payment-required");
  if (!raw) return null;
  const profile = CHAIN_PROFILES[network];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)))) as { accepts?: unknown };
    if (!Array.isArray(parsed.accepts)) return null;
    for (const item of parsed.accepts) {
      if (typeof item !== "object" || item === null) continue;
      const accept = item as Record<string, unknown>;
      const amount = accept.amount ?? accept.maxAmountRequired;
      if (accept.scheme !== "exact") continue;
      if (accept.network !== profile.network && accept.network !== profile.v1Slug) continue;
      if (typeof accept.asset !== "string" || accept.asset.toLowerCase() !== profile.asset.toLowerCase()) continue;
      if (typeof accept.payTo !== "string" || !WALLET_RE.test(accept.payTo)) continue;
      if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) continue;
      return { payTo: accept.payTo, amountUsd: Number(amount) / USDC_UNITS };
    }
    return null;
  } catch {
    return null;
  }
}

export async function pay(url: string | URL, init: RequestInit | undefined, options: PayOptions): Promise<PayResult> {
  if (typeof url !== "string" && !(url instanceof URL)) {
    throw new Error("invalid_url: pass the URL as a string or URL, and put the method, headers and body in init");
  }
  const resource = String(url);
  if (new URL(resource).protocol !== "https:") throw new Error("invalid_url: the seller URL must use https");
  if (!options || options.account === undefined || options.account === null) throw new Error("invalid_payer: pass account");
  const maxUsd = options.maxUsd ?? DEFAULT_MAX_PER_TX_USD;
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("invalid_max_usd: pass a positive number");
  const network = options.network ?? "base";
  if (!Object.hasOwn(CHAIN_PROFILES, network)) throw new Error("invalid_network");
  assertReplayableBody(init?.body);

  const method = (init?.method ?? "GET").toUpperCase();
  const baseFetch = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  let sellerAnswer: Response | null = null;

  // Every request to the seller carries the caller's method, headers and body. A URL with no record
  // can only pass through the payee score, so that read is closed unless the caller allowed it.
  const guardedFetch: typeof fetch = async (input, callInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.startsWith(`${apiBase}/payees/`) && options.allowUnknown !== true) {
      throw new Error("unknown_seller_not_allowed");
    }
    if (target !== resource) return baseFetch(input, callInit);
    const headers = new Headers(init?.headers);
    new Headers(callInit?.headers).forEach((value, key) => headers.set(key, value));
    const answer = await baseFetch(resource, { ...init, ...callInit, method, headers, body: init?.body });
    if (headers.has("payment-signature") || headers.has("x-payment")) sellerAnswer = answer.clone();
    return answer;
  };

  let first: Response;
  try {
    first = await guardedFetch(resource);
  } catch {
    return refused("seller_unreachable");
  }
  if (first.status !== 402) {
    if (first.ok) {
      return { status: "no_payment_required", response: first, recommendation: null, reasonCodes: [], signed: false, txHash: null, receipt: null };
    }
    return refused("no_payment_request");
  }
  const offer = readOffer(first, network);
  if (offer === null) return refused("no_eligible_accept");
  if (offer.amountUsd > maxUsd) return refused("price_above_ceiling");

  const policy: PayPolicy = options.allowWarn === true
    ? { maxPerTxUsd: maxUsd, requireVet402Allow: false, evidence: { minL1Deliveries: 1 } }
    : { maxPerTxUsd: maxUsd };

  const result: PayOrRefuseResult = await payOrRefuse({
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
