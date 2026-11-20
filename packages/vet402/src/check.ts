// check(url): one read for "has vet402 seen this x402 URL deliver?".
// Two existing routes through @vet402/sdk's client, so the key, timeout and
// User-Agent behave exactly as they do there:
//   GET /api/v1/resolve?q=<url>                       (key-less)
//   GET /api/v1/resources/{resourceId}/decision?role=payer (key-less at 60/min per IP)
// No payment code here.
import { createVouchClient, DEFAULT_API_URL, DEFAULT_MAX_SCORE_AGE_MS, VouchApiError, type DecisionRecommendation } from "@vet402/sdk";

/** Same predicate as `@vet402/sdk` `scoreQualityDefect`. Keep in sync with packages/sdk/src/verdict-shape.ts. */
function scoreQualityDefect(
  score: { degraded?: unknown; signalsUnavailable?: unknown } | null | undefined,
): "degraded" | "unreadable" | "partial" | null {
  if (score === null || typeof score !== "object") return "degraded";
  if (typeof score.degraded !== "boolean" || score.degraded === true) return "degraded";
  const signals = score.signalsUnavailable;
  if (signals === undefined) return null;
  if (!Array.isArray(signals)) return "unreadable";
  return signals.length > 0 ? "partial" : null;
}

export { DEFAULT_API_URL };

/** Public page of one record. Same form as the hosted MCP server's record_url. */
export const RECORD_URL_BASE = "https://vet402.com/observatory/e/";

export type CheckOptions = {
  /** API key from https://vet402.com/dashboard/keys. Optional: without one no Authorization header is sent. */
  apiKey?: string;
  /** Defaults to {@link DEFAULT_API_URL}. */
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Terms of the last purchase where content came back. Null on CheckFound when there is none. */
export type VerifiedTerms = {
  purchase_id: string | null;
  pay_to: string;
  asset: string;
  amount: string;
  decimals: 6;
  network: string;
  scheme: "exact" | "charge";
  protocol: "x402" | "mpp";
  verified_at: string;
};

export type CheckFound = {
  recommendation: DecisionRecommendation;
  reasonCodes: string[];
  verifiedTerms: VerifiedTerms | null;
  resourceId: string;
  evidenceUrl: string;
  /** When check read the decision. */
  retrievedAt: string;
  /** When vet402 scored it. */
  scoredAt: string;
  /** Copied from the payer decision when vet402 marks a degraded or partial read. */
  degraded?: boolean;
  signalsUnavailable?: string[];
};

export type CheckUnknown = {
  recommendation: "UNKNOWN";
  reason: string;
};

export type CheckResult = CheckFound | CheckUnknown;

function assertHttpsApiUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("invalid_api_url");
  }
  if (parsed.protocol === "https:") return;
  const host = parsed.hostname;
  if (parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return;
  throw new Error("invalid_api_url");
}

function decisionTooStale(scoredAt: string, cacheExpiresAt: string | undefined, nowMs: number): boolean {
  const scoredMs = Date.parse(scoredAt);
  if (Number.isNaN(scoredMs)) return true;
  if (nowMs - scoredMs > DEFAULT_MAX_SCORE_AGE_MS) return true;
  if (typeof cacheExpiresAt === "string") {
    const exp = Date.parse(cacheExpiresAt);
    if (!Number.isNaN(exp) && nowMs >= exp) return true;
  }
  return false;
}

export async function check(url: string, opts: CheckOptions = {}): Promise<CheckResult> {
  if (typeof url !== "string" || url.trim().length === 0) throw new Error("invalid_query");
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  assertHttpsApiUrl(apiUrl);
  const client = createVouchClient({ apiKey: opts.apiKey, apiUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs });

  const resolved = await call(apiUrl, () => client.resolve(url)).catch((err: unknown) => {
    if (err instanceof VouchApiError && err.status === 404) return null;
    throw err;
  });
  if (resolved === null) return { recommendation: "UNKNOWN", reason: "not_found" };
  const resource = resolved.resource;
  const resourceId = resource?.resource_id;
  if (!resource || !resourceId) {
    // not_found.reason when the body has not_found. Otherwise url_not_on_record:
    // the host has listings but this URL does not.
    const nf = (resolved as { not_found?: { reason?: string } }).not_found;
    return { recommendation: "UNKNOWN", reason: nf?.reason ?? "url_not_on_record" };
  }

  const decision = await call(apiUrl, () => client.getDecision(resourceId, { role: "payer" })).catch((err: unknown) => {
    if (err instanceof VouchApiError && err.status === 404) return null;
    throw err;
  });
  if (decision === null) return { recommendation: "UNKNOWN", reason: "not_found" };
  if (decisionTooStale(decision.scoredAt, decision.cacheExpiresAt, Date.now())) {
    return { recommendation: "UNKNOWN", reason: "stale" };
  }
  const body = decision as { degraded?: unknown; signalsUnavailable?: unknown; verified_terms?: VerifiedTerms | null };
  const terms = body.verified_terms ?? null;
  const degradedFlag = body.degraded === true;
  const signals = body.signalsUnavailable;
  const signalsUnavailable = Array.isArray(signals) ? [...signals] : undefined;
  const defect = scoreQualityDefect({ degraded: body.degraded, signalsUnavailable: signals });
  if (decision.recommendation === "ALLOW" && defect !== null) {
    const reason = defect === "partial" || defect === "unreadable" ? "partial" : "degraded";
    return { recommendation: "UNKNOWN", reason };
  }
  return {
    recommendation: decision.recommendation,
    reasonCodes: [...(decision.reason_codes ?? [])],
    verifiedTerms: terms,
    resourceId,
    evidenceUrl: `${RECORD_URL_BASE}${resource.observatory_id}`,
    retrievedAt: new Date().toISOString(),
    scoredAt: decision.scoredAt,
    ...(degradedFlag || signalsUnavailable !== undefined ? { degraded: degradedFlag, signalsUnavailable } : {}),
  };
}

// API answers (VouchApiError) pass through as the server's own code. A caller
// error thrown before the request (a message that starts with invalid_) passes
// through as itself, because fn() runs outside the try. The try wraps the
// request, and a failure there gets a message that says the API could not be reached.
async function call<T>(apiUrl: string, fn: () => Promise<T>): Promise<T> {
  const pending = fn();
  try {
    return await pending;
  } catch (err) {
    if (err instanceof VouchApiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`vet402: could not reach ${apiUrl} (${msg})`, { cause: err });
  }
}
