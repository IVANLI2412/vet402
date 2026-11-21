import { DEFAULT_MAX_PER_TX_USD } from "./ceiling.js";
const SESSION_MAX_ENV = "VOUCH_SESSION_MAX_USD";
const WAIVE_ENV = "VOUCH_ALLOW_WAIVE_VET402";
const L1_FLOOR_ENV = "VOUCH_MIN_L1_DELIVERIES";
const SOURCE_RANK = { vet402: 0, subgraph: 1, both: 2 };
let sessionSpentUsd = 0;
export function resetSessionSpendForTests() {
    sessionSpentUsd = 0;
}
export function sessionCapUsd(rawEnv) {
    const trimmed = typeof rawEnv === "string" ? rawEnv.trim() : "";
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return DEFAULT_MAX_PER_TX_USD * 10;
    return parsed;
}
export function policyFromEnv(env) {
    const waive = env[WAIVE_ENV]?.trim().toLowerCase() === "true";
    const l1 = Number(env[L1_FLOOR_ENV]);
    const evidence = waive && Number.isInteger(l1) && l1 >= 1 ? { minL1Deliveries: l1, source: "vet402" } : undefined;
    return {
        requireVet402Allow: !waive,
        ...(evidence ? { evidence } : {}),
    };
}
function maxFloor(a, b) {
    const vals = [a, b].filter((n) => typeof n === "number" && Number.isInteger(n) && n >= 0);
    if (vals.length === 0)
        return undefined;
    return Math.max(...vals);
}
function narrowSource(envSource, toolSource) {
    const env = envSource ?? "vet402";
    if (toolSource === undefined)
        return env;
    return SOURCE_RANK[toolSource] <= SOURCE_RANK[env] ? toolSource : env;
}
function mergedEvidence(envEv, toolEv) {
    const minL1 = maxFloor(envEv?.minL1Deliveries, toolEv?.minL1Deliveries);
    const minSub = maxFloor(envEv?.minSubgraphReceipts, toolEv?.minSubgraphReceipts);
    const source = narrowSource(envEv?.source, toolEv?.source);
    if (minL1 === undefined && minSub === undefined && envEv === undefined && toolEv === undefined)
        return undefined;
    return {
        source,
        ...(minL1 !== undefined && minL1 > 0 ? { minL1Deliveries: minL1 } : {}),
        ...(minSub !== undefined && minSub > 0 ? { minSubgraphReceipts: minSub } : {}),
    };
}
/** Tool input may only tighten policy relative to env (never waive or lower floors). */
export function mergePolicyFromEnv(envPolicy, tool) {
    const envWaive = envPolicy.requireVet402Allow === false;
    let requireVet402Allow = true;
    if (tool?.requireVet402Allow === true) {
        requireVet402Allow = true;
    }
    else if (envWaive && tool?.requireVet402Allow === false) {
        requireVet402Allow = false;
    }
    else if (envWaive && tool?.requireVet402Allow === undefined) {
        requireVet402Allow = false;
    }
    const evidence = mergedEvidence(envPolicy.evidence, tool?.evidence);
    if (!requireVet402Allow) {
        const floors = [evidence?.minL1Deliveries, evidence?.minSubgraphReceipts].some((n) => typeof n === "number" && n >= 1);
        if (!floors)
            return { requireVet402Allow: true };
        return { requireVet402Allow: false, ...(evidence ? { evidence } : {}) };
    }
    return {
        requireVet402Allow: true,
        ...(evidence ? { evidence } : {}),
    };
}
/** @deprecated Use tryReserveSessionSpend — kept for tests that import chargeSessionSpend directly. */
export function sessionWouldExceed(amountUsd, cap) {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0)
        return false;
    return sessionSpentUsd + amountUsd > cap;
}
/** Reserve spend before an awaited payment; release with {@link releaseSessionSpend} if nothing was signed. */
export function tryReserveSessionSpend(amountUsd, cap) {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0)
        return true;
    if (sessionSpentUsd + amountUsd > cap)
        return false;
    sessionSpentUsd += amountUsd;
    return true;
}
export function releaseSessionSpend(amountUsd) {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0)
        return;
    sessionSpentUsd = Math.max(0, sessionSpentUsd - amountUsd);
}
export function sessionSpentTotal() {
    return sessionSpentUsd;
}
export function chargeSessionSpend(amountUsd, cap) {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0)
        return true;
    if (sessionSpentUsd + amountUsd > cap)
        return false;
    sessionSpentUsd += amountUsd;
    return true;
}
