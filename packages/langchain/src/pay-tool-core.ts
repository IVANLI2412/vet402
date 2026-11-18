import { pay, type PayOptions, type PayStatus, type PayerAccount } from "@vet402/sdk";

export const RESPONSE_BODY_CAP = 20_000;

const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "payment-signature", "x-payment"]);

const POLICY_INPUT_KEYS = ["account", "maxUsd", "allowWarn", "allowUnknown"] as const;

export type Vet402PayToolOptions = {
  account: PayerAccount;
  maxUsd?: number;
  allowWarn?: boolean;
  allowUnknown?: boolean;
  allowedHosts?: readonly string[];
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
};

function refuse(reason: string, recommendation: string | null = null): Vet402PayToolResult {
  return {
    status: "refused",
    recommendation,
    reasonCodes: [reason],
    txHash: null,
    responseBody: null,
    responseBodyTruncated: false,
    guidance: "Payment was not made.",
  };
}

async function readResponseBody(response: Response | null): Promise<{ text: string | null; truncated: boolean }> {
  if (!response) return { text: null, truncated: false };
  try {
    const raw = await response.text();
    if (raw.length > RESPONSE_BODY_CAP) {
      return { text: `${raw.slice(0, RESPONSE_BODY_CAP)}...[truncated]`, truncated: true };
    }
    return { text: raw, truncated: false };
  } catch {
    return { text: null, truncated: false };
  }
}

function guidanceFor(status: PayStatus): string {
  if (status === "paid") return "Payment completed.";
  if (status === "no_payment_required") return "The seller answered without requiring payment.";
  if (status === "failed") {
    return "Payment may have succeeded. Do not retry without checking chain state.";
  }
  return "Payment was not made.";
}

export async function executeVet402Pay(
  rawInput: Record<string, unknown>,
  options: Vet402PayToolOptions,
): Promise<Vet402PayToolResult> {
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

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const ok = options.allowedHosts.some((entry) => entry.toLowerCase() === host);
    if (!ok) return refuse("host_not_allowed");
  }

  const headers = rawInput.headers;
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      return refuse("tool_input_invalid_headers");
    }
    for (const name of Object.keys(headers)) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        return refuse("forbidden_header");
      }
    }
  }

  const init: RequestInit = {};
  if (rawInput.method !== undefined) {
    if (typeof rawInput.method !== "string") return refuse("tool_input_invalid_method");
    init.method = rawInput.method;
  }
  if (rawInput.body !== undefined) {
    if (typeof rawInput.body !== "string") return refuse("tool_input_invalid_body");
    init.body = rawInput.body;
  }
  if (headers) {
    init.headers = headers as Record<string, string>;
  }

  try {
    const result = await pay(url, init, {
      account: options.account,
      maxUsd: options.maxUsd,
      allowWarn: options.allowWarn,
      allowUnknown: options.allowUnknown,
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      network: options.network,
      decisionStore: options.decisionStore,
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "tool_execution_error";
    return refuse(message.startsWith("invalid_") ? message : "tool_execution_error");
  }
}