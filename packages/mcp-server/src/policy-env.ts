import type { PayEvidencePolicy, PayPolicy } from "@vet402/sdk";
import { DEFAULT_MAX_PER_TX_USD } from "./ceiling.js";

const SESSION_MAX_ENV = "VOUCH_SESSION_MAX_USD";
const WAIVE_ENV = "VOUCH_ALLOW_WAIVE_VET402";
const L1_FLOOR_ENV = "VOUCH_MIN_L1_DELIVERIES";

type EvidenceSource = NonNullable<PayEvidencePolicy["source"]>;

let sessionSpentUsd = 0;

export function resetSessionSpendForTests(): void {
  sessionSpentUsd = 0;
}

export function sessionCapUsd(rawEnv: string | undefined): number {
  const trimmed = typeof rawEnv === "string" ? rawEnv.trim() : "";
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PER_TX_USD * 10;
  return parsed;
}

export function policyFromEnv(env: NodeJS.ProcessEnv): PayPolicy {
  const waive = env[WAIVE_ENV]?.trim().toLowerCase() === "true";
  const l1 = Number(env[L1_FLOOR_ENV]);
  const evidence: PayEvidencePolicy | undefined =
    waive && Number.isInteger(l1) && l1 >= 1 ? { minL1Deliveries: l1, source: "vet402" } : undefined;
  return {
    requireVet402Allow: !waive,
    ...(evidence ? { evidence } : {}),
  };
}

function maxFloor(a: number | undefined, b: number | undefined): number | undefined {
  const vals = [a, b].filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0);
  if (vals.length === 0) return undefined;
  return Math.max(...vals);
}

/**
 * source は厳しい側へ合成する（11/22 証明の監査 whitehat-R5-1 / adversary-N4）。
 * 同じなら その値、違えば both（両方を読み、どちらかが読めなければ拒否）。
 * ツールが The Graph を求めて鍵が無い時は、SDK の graph_key_not_configured で拒否される。
 */
function strictestSource(envSource: EvidenceSource | undefined, toolSource: EvidenceSource | undefined): EvidenceSource {
  const env = envSource ?? "vet402";
  if (toolSource === undefined || toolSource === env) return env;
  return "both";
}

function mergedEvidence(
  envEv: PayEvidencePolicy | undefined,
  toolEv: PayEvidencePolicy | undefined,
): PayEvidencePolicy | undefined {
  const minL1 = maxFloor(envEv?.minL1Deliveries, toolEv?.minL1Deliveries);
  const minSub = maxFloor(envEv?.minSubgraphReceipts, toolEv?.minSubgraphReceipts);
  const source = strictestSource(envEv?.source, toolEv?.source);
  if (minL1 === undefined && minSub === undefined && envEv === undefined && toolEv === undefined) return undefined;
  return {
    source,
    ...(minL1 !== undefined && minL1 > 0 ? { minL1Deliveries: minL1 } : {}),
    ...(minSub !== undefined && minSub > 0 ? { minSubgraphReceipts: minSub } : {}),
  };
}

/** Tool input may only tighten policy relative to env (never waive or lower floors). */
export function mergePolicyFromEnv(envPolicy: PayPolicy, tool?: PayPolicy): PayPolicy {
  const envWaive = envPolicy.requireVet402Allow === false;
  let requireVet402Allow = true;
  if (tool?.requireVet402Allow === true) {
    requireVet402Allow = true;
  } else if (envWaive && tool?.requireVet402Allow === false) {
    requireVet402Allow = false;
  } else if (envWaive && tool?.requireVet402Allow === undefined) {
    requireVet402Allow = false;
  }

  const evidence = mergedEvidence(envPolicy.evidence, tool?.evidence);

  if (!requireVet402Allow) {
    const floors = [evidence?.minL1Deliveries, evidence?.minSubgraphReceipts].some(
      (n) => typeof n === "number" && n >= 1,
    );
    if (!floors) return { requireVet402Allow: true };
    return { requireVet402Allow: false, ...(evidence ? { evidence } : {}) };
  }

  return {
    requireVet402Allow: true,
    ...(evidence ? { evidence } : {}),
  };
}

/** @deprecated Use tryReserveSessionSpend — kept for tests that import chargeSessionSpend directly. */
export function sessionWouldExceed(amountUsd: number, cap: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return false;
  return sessionSpentUsd + amountUsd > cap;
}

/** Reserve spend before an awaited payment; release with {@link releaseSessionSpend} if nothing was signed. */
export function tryReserveSessionSpend(amountUsd: number, cap: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return true;
  if (sessionSpentUsd + amountUsd > cap) return false;
  sessionSpentUsd += amountUsd;
  return true;
}

export function releaseSessionSpend(amountUsd: number): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  sessionSpentUsd = Math.max(0, sessionSpentUsd - amountUsd);
}

export function sessionSpentTotal(): number {
  return sessionSpentUsd;
}

export function chargeSessionSpend(amountUsd: number, cap: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return true;
  if (sessionSpentUsd + amountUsd > cap) return false;
  sessionSpentUsd += amountUsd;
  return true;
}