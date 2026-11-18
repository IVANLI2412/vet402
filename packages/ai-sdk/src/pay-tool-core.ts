import {
  pay,
  DEFAULT_MAX_PER_TX_USD,
  type PayOptions,
  type PayReceipt,
  type PayStatus,
  type PayerAccount,
} from "@vet402/sdk";

export const RESPONSE_BODY_CAP = 20_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const TRUNC_SUFFIX = "...[truncated]";
const TRUNCATED_TEXT_MAX = RESPONSE_BODY_CAP - TRUNC_SUFFIX.length;
const RESPONSE_READ_BYTE_LIMIT = RESPONSE_BODY_CAP + 8_192;

const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "payment-signature", "x-payment"]);

const POLICY_INPUT_KEYS = ["account", "maxUsd", "allowWarn", "allowUnknown", "maxTotalUsd"] as const;

const STATE = Symbol.for("@vet402/pay-tool-instance-state");

const USDC_UNITS = 1_000_000;

type InstanceState = {
  failedAttempts: Map<string, Vet402PayReceiptSummary>;
  committedUsd: number;
  reservedUsd: number;
  lock: Promise<void>;
};

export type Vet402PayReceiptSummary = {
  nonce: string | null;
  payTo: string | null;
  amount: string | null;
  network: string | null;
};

export type Vet402PayToolOptions = {
  account: PayerAccount;
  maxUsd?: number;
  /** Signed-payment total cap for this tool instance. Default is 10× {@link maxUsd}. */
  maxTotalUsd?: number;
  allowWarn?: boolean;
  allowUnknown?: boolean;
  allowedHosts: readonly string[];
  fetchTimeoutMs?: number;
  apiKey?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  network?: PayOptions["network"];
  decisionStore?: string;
};

export type Vet402PayToolResult = {
  status: PayStatus;
  recommendation: string | null;
  reasonCodes: string[];
  txHash: string | null;
  responseBody: string | null;
  responseBodyTruncated: boolean;
  guidance: string;
  receipt?: Vet402PayReceiptSummary | null;
};

function createInstanceState(): InstanceState {
  return { failedAttempts: new Map(), committedUsd: 0, reservedUsd: 0, lock: Promise.resolve() };
}

/** Attach per-instance counters and duplicate guards. Factories call this once per tool. */
export function bindVet402PayTool(options: Vet402PayToolOptions): Vet402PayToolOptions {
  const bound = { ...options } as Vet402PayToolOptions & { [STATE]?: InstanceState };
  if (!bound[STATE]) bound[STATE] = createInstanceState();
  return bound;
}

function instanceState(options: Vet402PayToolOptions): InstanceState {
  const withState = options as Vet402PayToolOptions & { [STATE]?: InstanceState };
  if (!withState[STATE]) withState[STATE] = createInstanceState();
  return withState[STATE]!;
}

function refuse(
  reason: string,
  recommendation: string | null = null,
  extra: Partial<Vet402PayToolResult> = {},
): Vet402PayToolResult {
  return {
    status: "refused",
    recommendation,
    reasonCodes: [reason],
    txHash: null,
    responseBody: null,
    responseBodyTruncated: false,
    guidance: "Payment was not made.",
    receipt: null,
    ...extra,
  };
}

function truncateToCodePointBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = maxLen;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

async function readResponseBody(response: Response | null): Promise<{ text: string | null; truncated: boolean }> {
  if (!response?.body) return { text: null, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let decoded = "";
  let bytesRead = 0;
  let extra = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > RESPONSE_READ_BYTE_LIMIT) {
        extra = true;
        const room = RESPONSE_READ_BYTE_LIMIT - (bytesRead - value.byteLength);
        if (room > 0) decoded += decoder.decode(value.subarray(0, room), { stream: true });
        break;
      }
      decoded += decoder.decode(value, { stream: true });
    }
    decoded += decoder.decode();
  } catch {
    return { text: null, truncated: false };
  } finally {
    reader.cancel().catch(() => undefined);
  }

  const truncated = extra || decoded.length > TRUNCATED_TEXT_MAX;
  if (!truncated) return { text: decoded, truncated: false };
  const text = `${truncateToCodePointBoundary(decoded, TRUNCATED_TEXT_MAX)}${TRUNC_SUFFIX}`;
  return { text, truncated: true };
}

function guidanceFor(status: PayStatus): string {
  if (status === "paid") return "Payment completed.";
  if (status === "no_payment_required") return "The seller answered without requiring payment.";
  if (status === "failed") {
    return "Payment may have succeeded. Do not retry without checking chain state.";
  }
  return "Payment was not made.";
}

function paymentAttemptKey(url: string, method: string): string {
  return `${method}\0${url}`;
}

function receiptSummary(receipt: PayReceipt | null): Vet402PayReceiptSummary | null {
  if (!receipt) return null;
  const nonce = receipt.retry.authorization?.nonce ?? receipt.retry.svm?.memo ?? null;
  return {
    nonce,
    payTo: receipt.payTo,
    amount: receipt.amount,
    network: receipt.network,
  };
}

function amountUsdFromReceipt(receipt: PayReceipt | null): number | null {
  if (!receipt?.amount || !/^[1-9][0-9]*$/.test(receipt.amount)) return null;
  return Number(receipt.amount) / USDC_UNITS;
}

function parseAllowedHost(entry: string): { host: string; port: number } {
  const lower = entry.trim().toLowerCase();
  const lastColon = lower.lastIndexOf(":");
  if (lastColon > 0 && lastColon === lower.indexOf(":")) {
    const host = lower.slice(0, lastColon);
    const port = Number(lower.slice(lastColon + 1));
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return { host, port };
  }
  return { host: lower, port: 443 };
}

function urlPort(parsed: URL): number {
  if (parsed.port) {
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return 443;
}

function hostIsAllowed(parsed: URL, allowedHosts: readonly string[]): boolean {
  const hostname = parsed.hostname.toLowerCase();
  const port = urlPort(parsed);
  return allowedHosts.some((entry) => {
    const rule = parseAllowedHost(entry);
    return rule.host === hostname && rule.port === port;
  });
}

function withTimeoutFetch(base: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let merged: AbortSignal = timeoutSignal;
    if (init.signal !== undefined && init.signal !== null) {
      merged =
        typeof AbortSignal.any === "function"
          ? (AbortSignal.any([init.signal, timeoutSignal]) as AbortSignal)
          : timeoutSignal;
    }
    const call = base(input, { ...init, signal: merged });
    const onTimeout = new Promise<never>((_, reject) => {
      if (timeoutSignal.aborted) {
        reject(Object.assign(new Error("fetch_timeout"), { cause: timeoutSignal.reason }));
        return;
      }
      timeoutSignal.addEventListener(
        "abort",
        () => {
          reject(Object.assign(new Error("fetch_timeout"), { cause: timeoutSignal.reason }));
        },
        { once: true },
      );
    });
    try {
      return await Promise.race([call, onTimeout]);
    } catch (err) {
      if (err instanceof Error && err.message === "fetch_timeout") throw err;
      if (timeoutSignal.aborted) {
        throw Object.assign(new Error("fetch_timeout"), { cause: err });
      }
      throw err;
    }
  };
}

async function withInstanceLock<T>(state: InstanceState, fn: () => Promise<T>): Promise<T> {
  const prev = state.lock;
  let release!: () => void;
  state.lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function duplicateBlocked(summary: Vet402PayReceiptSummary): Vet402PayToolResult {
  return {
    status: "refused",
    recommendation: null,
    reasonCodes: ["duplicate_payment_blocked"],
    txHash: null,
    responseBody: null,
    responseBodyTruncated: false,
    guidance: "この支払いを再試行しないでください",
    receipt: summary,
  };
}

export async function executeVet402Pay(
  rawInput: Record<string, unknown>,
  options: Vet402PayToolOptions,
): Promise<Vet402PayToolResult> {
  if (options.allowedHosts === undefined) {
    return refuse("allowed_hosts_required");
  }

  for (const key of POLICY_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rawInput, key) && rawInput[key] !== undefined) {
      return refuse("tool_input_policy_field");
    }
  }

  const url = rawInput.url;
  if (typeof url !== "string" || url.length === 0) {
    return refuse("tool_input_invalid_url");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse("tool_input_invalid_url");
  }
  if (parsed.protocol !== "https:") {
    return refuse("tool_input_invalid_url");
  }

  if (options.allowedHosts.length === 0 || !hostIsAllowed(parsed, options.allowedHosts)) {
    return refuse("host_not_allowed");
  }

  const method =
    rawInput.method === undefined
      ? "GET"
      : typeof rawInput.method === "string"
        ? rawInput.method.toUpperCase()
        : null;
  if (method === null) return refuse("tool_input_invalid_method");

  const state = instanceState(options);
  const attemptKey = paymentAttemptKey(url, method);
  const priorFailure = state.failedAttempts.get(attemptKey);
  if (priorFailure) return duplicateBlocked(priorFailure);

  const headers = rawInput.headers;
  if (headers !== undefined) {
    if (headers instanceof Headers || headers instanceof Map) {
      return refuse("tool_input_invalid_headers");
    }
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      return refuse("tool_input_invalid_headers");
    }
    for (const name of Object.keys(headers)) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        return refuse("forbidden_header");
      }
    }
  }

  const init: RequestInit = { method };
  if (rawInput.body !== undefined) {
    if (typeof rawInput.body !== "string") return refuse("tool_input_invalid_body");
    init.body = rawInput.body;
  }
  if (headers) {
    init.headers = headers as Record<string, string>;
  }

  const perTxUsd = options.maxUsd ?? DEFAULT_MAX_PER_TX_USD;
  const totalCap = options.maxTotalUsd ?? perTxUsd * 10;
  const reserved = await withInstanceLock(state, async () => {
    const remaining = totalCap - state.committedUsd - state.reservedUsd;
    if (remaining < perTxUsd) return false;
    state.reservedUsd += perTxUsd;
    return true;
  });
  if (!reserved) return refuse("max_total_usd_exceeded");

  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const innerTimed = withTimeoutFetch(baseFetch, timeoutMs);
  let sellerTimedOut = false;
  const timedFetch: typeof fetch = async (input, init) => {
    try {
      return await innerTimed(input, init);
    } catch (err) {
      if (err instanceof Error && err.message === "fetch_timeout") sellerTimedOut = true;
      throw err;
    }
  };

  try {
    const result = await pay(url, init, {
      account: options.account,
      maxUsd: options.maxUsd,
      allowWarn: options.allowWarn,
      allowUnknown: options.allowUnknown,
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      fetch: timedFetch,
      network: options.network,
      decisionStore: options.decisionStore,
    });

    if (
      sellerTimedOut &&
      result.status === "refused" &&
      result.reasonCodes.length > 0 &&
      result.reasonCodes[0] === "seller_unreachable"
    ) {
      await withInstanceLock(state, async () => {
        state.reservedUsd -= perTxUsd;
      });
      return refuse("fetch_timeout");
    }

    const summary = receiptSummary(result.receipt);
    const signedSpend = result.signed && (result.status === "paid" || result.status === "failed");
    const spentUsd = signedSpend ? (amountUsdFromReceipt(result.receipt) ?? perTxUsd) : 0;

    await withInstanceLock(state, async () => {
      state.reservedUsd -= perTxUsd;
      if (signedSpend) {
        state.committedUsd += spentUsd;
        if (result.status === "failed" && summary) {
          state.failedAttempts.set(attemptKey, summary);
        }
      }
    });

    const body = await readResponseBody(result.response);
    return {
      status: result.status,
      recommendation: result.recommendation,
      reasonCodes: result.reasonCodes,
      txHash: result.txHash,
      responseBody: body.text,
      responseBodyTruncated: body.truncated,
      guidance: guidanceFor(result.status),
      receipt: summary,
    };
  } catch (err) {
    await withInstanceLock(state, async () => {
      state.reservedUsd -= perTxUsd;
    });
    const message = err instanceof Error ? err.message : "tool_execution_error";
    if (message === "fetch_timeout") return refuse("fetch_timeout");
    if (message.startsWith("invalid_")) return refuse("tool_execution_error");
    return refuse("tool_execution_error");
  }
}