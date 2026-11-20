import type { PayEvidencePolicy, PayPolicy } from "@vet402/sdk";
import { DEFAULT_MAX_PER_TX_USD } from "./ceiling.js";

const SESSION_MAX_ENV = "VOUCH_SESSION_MAX_USD";
const WAIVE_ENV = "VOUCH_ALLOW_WAIVE_VET402";
const L1_FLOOR_ENV = "VOUCH_MIN_L1_DELIVERIES";

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

/** Tool input may only tighten policy relative to env (never waive or lower floors). */
export function mergePolicyFromEnv(envPolicy: PayPolicy, tool?: PayPolicy): PayPolicy {
  if (envPolicy.requireVet402Allow !== false) {
    return { ...envPolicy, requireVet402Allow: true, evidence: envPolicy.evidence };
  }
  const requireVet402Allow = tool?.requireVet402Allow === false ? false : true;
  if (requireVet402Allow) return { ...envPolicy, requireVet402Allow: true, evidence: envPolicy.evidence };
  const envFloor = envPolicy.evidence?.minL1Deliveries ?? 0;
  const toolFloor = tool?.evidence?.minL1Deliveries;
  const minL1 =
    typeof toolFloor === "number" && Number.isInteger(toolFloor) && toolFloor > envFloor ? toolFloor : envFloor;
  if (minL1 < 1) return { requireVet402Allow: true };
  return {
    requireVet402Allow: false,
    evidence: {
      source: tool?.evidence?.source ?? envPolicy.evidence?.source ?? "vet402",
      minL1Deliveries: minL1,
      ...(tool?.evidence?.minSubgraphReceipts !== undefined
        ? { minSubgraphReceipts: tool.evidence.minSubgraphReceipts }
        : {}),
    },
  };
}

export function chargeSessionSpend(amountUsd: number, cap: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return true;
  if (sessionSpentUsd + amountUsd > cap) return false;
  sessionSpentUsd += amountUsd;
  return true;
}