import { unstable_cache } from "next/cache";
import { isNoDataCacheError } from "@/lib/observatory/state-reads";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { runErc8004Check, type Erc8004CheckError, type Erc8004CheckInput, type Erc8004CheckDeps } from "./run-check";
import type { Erc8004CheckResult, Erc8004CheckUnreadableReason } from "./types";

export const ERC8004_CHECK_CACHE_SECONDS = 30 * 60;
export const ERC8004_CHECK_LOG_TIMEOUT_CACHE_SECONDS = 60;

const TEMPORARY_UNREADABLE_REASONS = new Set<Erc8004CheckUnreadableReason>([
  "feedback_log_not_found_in_time",
  "feedback_uri_unreadable",
]);

export function erc8004CheckCacheMaxAgeSeconds(result: Erc8004CheckResult): number {
  if (
    result.verdict === "unreadable" &&
    result.unreadable_reason &&
    TEMPORARY_UNREADABLE_REASONS.has(result.unreadable_reason)
  ) {
    return ERC8004_CHECK_LOG_TIMEOUT_CACHE_SECONDS;
  }
  return ERC8004_CHECK_CACHE_SECONDS;
}

function cacheKey(input: Erc8004CheckInput): string {
  return JSON.stringify({
    chain: input.chain ?? "eip155:8453",
    agentId: input.agentId ?? "",
    client: (input.client ?? "").toLowerCase(),
    feedbackIndex: input.feedbackIndex ?? "",
  });
}

export type Erc8004CheckCachedPayload = {
  out: Erc8004CheckResult;
  /** When this read started (ISO8601 UTC). Drives per-verdict freshness inside unstable_cache. */
  cacheReadAt: string;
};

export function isErc8004CachedReadFresh(
  payload: Erc8004CheckCachedPayload,
  nowMs: number = Date.now(),
): boolean {
  const readMs = Date.parse(payload.cacheReadAt);
  if (!Number.isFinite(readMs)) return false;
  return nowMs - readMs <= erc8004CheckCacheMaxAgeSeconds(payload.out) * 1000;
}

function freezeForCache(out: Erc8004CheckResult): Erc8004CheckResult {
  return JSON.parse(JSON.stringify(out)) as Erc8004CheckResult;
}

async function readErc8004CheckFresh(
  input: Erc8004CheckInput,
  deps?: Erc8004CheckDeps,
): Promise<Erc8004CheckResult | { error: Erc8004CheckError }> {
  const out = await runErc8004Check(input, deps);
  if ("error" in out) return out;
  return freezeForCache(out);
}

type CacheFn = typeof unstable_cache;

export type GetErc8004CheckCached = (
  input: Erc8004CheckInput,
  deps?: Erc8004CheckDeps,
) => Promise<Erc8004CheckResult | { error: Erc8004CheckError }>;

export function makeGetErc8004CheckCached(cache: CacheFn): GetErc8004CheckCached {
  return async (input, deps) => {
    const key = cacheKey(input);
    const read = cache(
      async (): Promise<Erc8004CheckCachedPayload | { error: Erc8004CheckError }> => {
        const cacheReadAt = new Date().toISOString();
        const out = await runErc8004Check(input, deps);
        if ("error" in out) return out;
        return { out: freezeForCache(out), cacheReadAt };
      },
      ["erc8004-check", key],
      { revalidate: ERC8004_CHECK_CACHE_SECONDS },
    );

    try {
      const cached = await read();
      if ("error" in cached) return cached;
      if (isErc8004CachedReadFresh(cached)) return cached.out;
      return await readErc8004CheckFresh(input, deps);
    } catch (error) {
      if (isNoDataCacheError(error)) return readErc8004CheckFresh(input, deps);
      logServerErrorSafe("erc8004_check_cache", error);
      throw error;
    }
  };
}

let getErc8004CheckCachedImpl = makeGetErc8004CheckCached(unstable_cache);

export function getErc8004CheckCached(
  input: Erc8004CheckInput,
  deps?: Erc8004CheckDeps,
): Promise<Erc8004CheckResult | { error: Erc8004CheckError }> {
  return getErc8004CheckCachedImpl(input, deps);
}

/** Test hook: swap unstable_cache (null restores production). */
export function __setErc8004CheckCacheForTests(cache: CacheFn | null): void {
  getErc8004CheckCachedImpl = makeGetErc8004CheckCached(cache ?? unstable_cache);
}