import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import {
  ERC8004_CHECK_CACHE_SECONDS,
  ERC8004_CHECK_LOG_TIMEOUT_CACHE_SECONDS,
  __setErc8004CheckCacheForTests,
  getErc8004CheckCached,
  isErc8004CachedReadFresh,
  type Erc8004CheckCachedPayload,
} from "@/lib/erc8004-check/cache";
import type { FeedbackLogSlice } from "@/lib/erc8004-check/registry-read";
import type { Erc8004CheckResult } from "@/lib/erc8004-check/types";

delete process.env.DATABASE_URL;

const CLIENT = "0x397558E5D63a894934362E5c3C33Ab5d0170c228" as Address;

const readers = {
  publicClient: {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getClients") return [CLIENT];
      if (functionName === "readFeedback") return [100n, 0, "tag-a", "", false];
      throw new Error(`unexpected ${functionName}`);
    },
  },
};

function temporaryUnreadable(asOf: string): Erc8004CheckResult {
  return {
    verdict: "unreadable",
    unreadable_reason: "feedback_log_not_found_in_time",
    chain: "eip155:8453",
    agentId: "1",
    clientAddress: CLIENT,
    feedbackIndex: "1",
    feedback: {
      value: "0",
      valueDecimals: 0,
      tag1: "",
      tag2: "",
      endpoint: "",
      feedbackURI: "",
      feedbackHash: `0x${"00".repeat(32)}` as Hex,
      isRevoked: false,
    },
    proofOfPayment: null,
    checks: {
      tx_exists: "unknown",
      to_matches_agent_payTo_or_wallet: "unknown",
      from_matches_client: "unknown",
      amount: "unknown",
      token: "unknown",
      block_time: "unknown",
      feedback_hash: "unknown",
    },
    sources: [],
    as_of: asOf,
  };
}

test("temporary unreadable uses the short freshness window, confirmed verdicts use 30 minutes", () => {
  const staleAt = new Date(Date.now() - (ERC8004_CHECK_LOG_TIMEOUT_CACHE_SECONDS + 5) * 1000).toISOString();
  const temporary: Erc8004CheckCachedPayload = {
    out: temporaryUnreadable("2026-11-20T10:00:00.000Z"),
    cacheReadAt: staleAt,
  };
  const confirmed: Erc8004CheckCachedPayload = {
    out: { ...temporary.out, verdict: "verified", unreadable_reason: undefined },
    cacheReadAt: staleAt,
  };
  assert.equal(isErc8004CachedReadFresh(temporary), false);
  assert.equal(isErc8004CachedReadFresh(confirmed), true);
  assert.equal(ERC8004_CHECK_CACHE_SECONDS, 30 * 60);
});

test("stale temporary unreadable in unstable_cache triggers a fresh read on the next call", async () => {
  let deadlineScans = 0;
  const staleAt = new Date(Date.now() - (ERC8004_CHECK_LOG_TIMEOUT_CACHE_SECONDS + 5) * 1000).toISOString();
  const payload: Erc8004CheckCachedPayload = {
    out: temporaryUnreadable("2026-11-20T10:00:00.000Z"),
    cacheReadAt: staleAt,
  };

  __setErc8004CheckCacheForTests((() => async () => payload) as unknown as Parameters<typeof __setErc8004CheckCacheForTests>[0]);

  const slice = (): FeedbackLogSlice => ({
    clientAddress: CLIENT,
    feedbackIndex: 1n,
    value: 100n,
    valueDecimals: 0,
    tag1: "tag-a",
    tag2: "",
    endpoint: "",
    feedbackURI: "https://example.invalid/f.json",
    feedbackHash: `0x${"00".repeat(32)}` as Hex,
    blockNumber: 1n,
    txHash: `0x${"00".repeat(32)}` as Hex,
  });

  const deps = {
    readers,
    findFeedbackLog: async () => {
      deadlineScans += 1;
      return { kind: "deadline" as const };
    },
    fetchFeedbackUri: async () => {
      throw new Error("unreadable uri");
    },
  };

  const input = { agentId: "1", client: CLIENT, feedbackIndex: "1" };
  const out = await getErc8004CheckCached(input, deps);
  assert.ok(!("error" in out));
  assert.equal(deadlineScans, 1, "stale temporary unreadable must not be served without a fresh read");

  __setErc8004CheckCacheForTests(null);
});