import { unstable_cache } from "next/cache";
import { runErc8004Check, type Erc8004CheckInput, type Erc8004CheckDeps } from "./run-check";

export const ERC8004_CHECK_CACHE_SECONDS = 30 * 60;

function cacheKey(input: Erc8004CheckInput): string {
  return JSON.stringify({
    chain: input.chain ?? "eip155:8453",
    agentId: input.agentId ?? "",
    client: (input.client ?? "").toLowerCase(),
    feedbackIndex: input.feedbackIndex ?? "",
  });
}

export function getErc8004CheckCached(input: Erc8004CheckInput, deps?: Erc8004CheckDeps) {
  const key = cacheKey(input);
  return unstable_cache(() => runErc8004Check(input, deps), ["erc8004-check", key], {
    revalidate: ERC8004_CHECK_CACHE_SECONDS,
  })();
}