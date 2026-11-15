import type { DecisionResult, DecisionSubject, RegistryStatus } from "@/lib/decision/decide";
import type { L1Basis } from "@/lib/decision/rules";
import type { Evidence, Freshness, SellerFacts, VerifiedTerms } from "@/lib/decision/types";

export const JUDGMENT_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const JUDGMENT_PUBLIC_NOTE =
  "Built once per UTC day from the same record as the key-less decision. Call live for the answer as of now.";

export const JUDGMENT_NOT_FOUND_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

export const JUDGMENT_UNAVAILABLE_CACHE_CONTROL = "no-store";

/**
 * 1 日キャッシュしない判定（2026-11-15 依頼主の指摘 2）。spending_halted は停止フラグの読み取り失敗でも true に倒れる
 * （kill-switch の fail-closed）ので、本物の停止と区別せず、true なら日次のキャッシュに載せない。degraded: true も同じ。
 * CDN は短く持つだけ（5 分）。
 */
export const JUDGMENT_TRANSIENT_CACHE_CONTROL = "public, max-age=60, s-maxage=300";

export function isTransientJudgment(doc: Record<string, unknown>): boolean {
  return doc.spending_halted === true || doc.degraded === true;
}

const PUBLIC_DECISION_KEYS = [
  "subject",
  "role",
  "recommendation",
  "reason_codes",
  "facts",
  "spending_halted",
  "not_attempted_reason",
  "freshness",
  "l1_basis",
  "verified_terms",
  "evidence",
  "degraded",
  "policy",
  "rules_version",
  "registry",
  "scoredAt",
  "disclaimer",
] as const satisfies readonly (keyof DecisionResult)[];

// SellerFacts / Evidence に公開の入れ子鍵 `payer` は無い。DecisionResult 最上位の `payer` は PUBLIC_DECISION_KEYS 外だが、
// facts / evidence[] の誤混入も strip する。
export const INTERNAL_KEY_NAMES = new Set([
  "apiKey",
  "api_key",
  "apiKeyId",
  "ownerId",
  "owner_id",
  "email",
  "contact",
  "contactEmail",
  "contact_email",
  "trustScore",
  "trust_score",
  "rawScore",
  "raw_score",
  "score",
  "secret",
  "privateKey",
  "private_key",
  "callerMaterial",
  "caller_hash",
  "callerHash",
  "caller_policy",
  "cacheExpiresAt",
  "payer",
  "password",
  "token_secret",
]);

export function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

export function judgmentCacheControl(now: Date): string {
  const s = Math.min(86400, Math.max(300, secondsUntilNextUtcDay(now)));
  return `public, max-age=300, s-maxage=${s}, stale-while-revalidate=86400`;
}

function stripInternalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (INTERNAL_KEY_NAMES.has(k)) continue;
      out[k] = stripInternalKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * 入れ子も許可リストで写す（2026-11-15 依頼主の指摘 3）。`true` は葉（文字列・数・真偽・null・それらの配列）。
 * 型ごとに Record<keyof T, …> で書くので、DecisionResult の型に鍵が増えると typecheck が落ち、ここを見直すことになる。
 * 葉に object が来たら落とす。許可リストに無い鍵も落とす。
 */
type Spec = true | { readonly [k: string]: Spec } | readonly [Spec];
type Shape<T> = { readonly [K in keyof Required<T>]: Spec };

const SUBJECT_SPEC: Shape<DecisionSubject> = {
  type: true,
  id: true,
  endpoint_id: true,
  observatory_id: true,
  canonical_url: true,
  method: true,
};
const SELLER_FACTS_SPEC: Shape<SellerFacts> = {
  l0: { status: true, observed_at: true, dialect: true, fail_reason: true } satisfies Shape<SellerFacts["l0"]>,
  l1: {
    n_delivered: true,
    n_settled: true,
    n_attempts: true,
    n_inconclusive: true,
    n_probe_error: true,
    p50_ms: true,
    p95_ms: true,
    last_purchase_id: true,
    observed_at: true,
    last_attempt_at: true,
  } satisfies Shape<SellerFacts["l1"]>,
  l2: {
    status: true,
    declaration_hash: true,
    response_hash: true,
    diff_hash: true,
    missing_keys: true,
    observed_at: true,
  } satisfies Shape<SellerFacts["l2"]>,
  availability_7d: true,
  availability_30d: true,
  offer_stability: true,
  payees: true,
  settlement_30d_real: true,
  settlement_30d_raw: true,
  settlement_30d_test: true,
  settlement_30d_measurement: true,
  unique_payers_30d_real: true,
  wash_dominated: true,
};
const FRESHNESS_SPEC: Shape<Freshness> = { l0: true, l1: true, l2: true };
const L1_BASIS_SPEC: Shape<L1Basis> = {
  window_days: true,
  fresh_days: true,
  n_counted: true,
  n_not_counted: true,
  n_paid_undelivered: true,
  n_paid_undelivered_since_last_delivery: true,
  n_paid_undelivered_seller_side_since_last_delivery: true,
  latest_counted_delivered: true,
  last_attempt_at: true,
  last_signed_attempt_at: true,
  last_delivered_at: true,
  days_since_last_attempt: true,
  days_since_last_delivery: true,
};
const VERIFIED_TERMS_SPEC: Shape<VerifiedTerms> = {
  purchase_id: true,
  pay_to: true,
  asset: true,
  amount: true,
  decimals: true,
  network: true,
  scheme: true,
  protocol: true,
  verified_at: true,
};
const EVIDENCE_SPEC: Shape<Evidence> = {
  level: true,
  source: true,
  purchase_id: true,
  observation_id: true,
  url: true,
  declaration_hash: true,
  response_hash: true,
  diff_hash: true,
  missing_keys: true,
  mismatch_kind: true,
  content_type: true,
  subgraphId: true,
  block: { number: true, timestamp: true } satisfies Shape<NonNullable<Evidence["block"]>>,
  deployment: true,
  queriedAt: true,
  receipts: true,
};
const REGISTRY_SPEC: Shape<RegistryStatus> = { status: true, tx_hash: true };

const PUBLIC_JUDGMENT_SPEC: { readonly [K in (typeof PUBLIC_DECISION_KEYS)[number]]: Spec } = {
  subject: SUBJECT_SPEC,
  role: true,
  recommendation: true,
  reason_codes: true,
  facts: SELLER_FACTS_SPEC,
  spending_halted: true,
  not_attempted_reason: true,
  freshness: FRESHNESS_SPEC,
  l1_basis: L1_BASIS_SPEC,
  verified_terms: VERIFIED_TERMS_SPEC,
  evidence: [EVIDENCE_SPEC],
  degraded: true,
  policy: true,
  rules_version: true,
  registry: REGISTRY_SPEC,
  scoredAt: true,
  disclaimer: true,
};

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** spec に沿って写す。写せない値は undefined（呼び手が鍵ごと落とす）。 */
function project(value: unknown, spec: Spec): unknown {
  if (spec === true) {
    if (isPrimitive(value)) return value;
    if (Array.isArray(value) && value.every(isPrimitive)) return [...value];
    return undefined;
  }
  if (Array.isArray(spec)) {
    if (value === null) return null;
    if (!Array.isArray(value)) return undefined;
    return value.map((v) => project(v, spec[0])).filter((v) => v !== undefined);
  }
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  const objSpec = spec as { readonly [k: string]: Spec };
  for (const key of Object.keys(objSpec)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const v = project((value as Record<string, unknown>)[key], objSpec[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function resourceIdFromSubject(subject: DecisionResult["subject"]): string {
  return subject.id ?? "";
}

/** Key-less /decision body fields only, plus judgment_day, built_at, live and note. */
export function toPublicJudgment(result: DecisionResult, day: string): Record<string, unknown> {
  const builtAt = new Date().toISOString();
  const resourceId = resourceIdFromSubject(result.subject);
  const picked: Record<string, unknown> = {};
  for (const key of PUBLIC_DECISION_KEYS) {
    if (!(key in result) || result[key] === undefined) continue;
    const v = project(result[key], PUBLIC_JUDGMENT_SPEC[key]);
    if (v !== undefined) picked[key] = v;
  }
  picked.judgment_day = day;
  picked.built_at = builtAt;
  picked.live = `https://vet402.com/api/v1/resources/${resourceId}/decision?role=payer`;
  picked.note = JUDGMENT_PUBLIC_NOTE;
  return stripInternalKeys(picked) as Record<string, unknown>;
}