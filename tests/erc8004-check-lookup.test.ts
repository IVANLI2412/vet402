// resolveClientForIndex / findFeedbackLog — 曖昧な index と log 走査の締切。
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Address, type Hex } from "viem";
import type { FeedbackLogSlice } from "@/lib/erc8004-check/registry-read";
import { runErc8004Check } from "@/lib/erc8004-check/run-check";

delete process.env.DATABASE_URL;

const AGENT = 1n;
const CLIENT_A = "0x397558E5D63a894934362E5c3C33Ab5d0170c228" as Address;
const CLIENT_B = "0xcbd946d0dc0ad404939f5868d8d6efedada0f7e3" as Address;
const INDEX = 1n;

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function metaReader(clients: readonly Address[]) {
  return {
    publicClient: {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === "getClients") return clients;
        if (functionName === "readFeedback") {
          const who = String(args?.[1]).toLowerCase();
          if (who === CLIENT_A.toLowerCase() || who === CLIENT_B.toLowerCase()) {
            return [100n, 0, "tag-a", "", false];
          }
          throw new Error("revert");
        }
        throw new Error(`unexpected ${functionName}`);
      },
    },
  };
}

test("index のみで client が2人とも同じ index → ambiguous_feedback_index（走査しない）", async () => {
  let logScans = 0;
  const result = await runErc8004Check(
    { agentId: "1", feedbackIndex: "1" },
    {
      readers: metaReader([CLIENT_A, CLIENT_B]),
      findFeedbackLog: async () => {
        logScans += 1;
        return { kind: "not_found" as const };
      },
    },
  );
  assert.deepEqual(result, { error: "ambiguous_feedback_index" });
  assert.equal(logScans, 0);
});

test("index のみで client が1人 → 従来どおり解決する", async () => {
  const slice: FeedbackLogSlice = {
    clientAddress: CLIENT_A,
    feedbackIndex: INDEX,
    value: 100n,
    valueDecimals: 0,
    tag1: "tag-a",
    tag2: "",
    endpoint: "https://example/",
    feedbackURI: "data:application/json,{}",
    feedbackHash: ZERO_HASH,
    blockNumber: 1n,
    txHash: ZERO_HASH,
  };
  const result = await runErc8004Check(
    { agentId: "1", feedbackIndex: "1" },
    {
      readers: metaReader([CLIENT_A]),
      findFeedbackLog: async () => slice,
      fetchFeedbackUri: async () => ({ body: "{}", contentType: "application/json" }),
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.clientAddress, CLIENT_A);
  assert.equal(result.feedbackIndex, "1");
});

test("findFeedbackLog が締切 → unreadable・on-chain の value あり", async () => {
  const result = await runErc8004Check(
    { agentId: "1", client: CLIENT_A, feedbackIndex: "1" },
    {
      readers: {
        publicClient: {
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "readFeedback") return [42n, 2, "reachable", "extra", true];
            throw new Error("unexpected");
          },
        },
      },
      findFeedbackLog: async () => ({ kind: "deadline" as const }),
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "unreadable");
  assert.equal(result.unreadable_reason, "feedback_log_not_found_in_time");
  assert.equal(result.feedback.value, "42");
  assert.equal(result.feedback.valueDecimals, 2);
  assert.equal(result.feedback.tag1, "reachable");
  assert.equal(result.feedback.tag2, "extra");
  assert.equal(result.feedback.isRevoked, true);
  assert.equal(result.proofOfPayment, null);
  assert.equal(result.checks.tx_exists, "unknown");
});

test("getClients が投げる → 例外（route は 503 chain_unreadable）", async () => {
  await assert.rejects(
    () =>
      runErc8004Check(
        { agentId: "1", feedbackIndex: "1" },
        {
          readers: {
            publicClient: {
              readContract: async () => {
                throw new Error("rpc_down");
              },
            },
          },
        },
      ),
    /rpc_down/,
  );
});

test("存在しない feedbackIndex → 404 feedback_not_found", async () => {
  const result = await runErc8004Check(
    { agentId: "1", feedbackIndex: "99" },
    {
      readers: {
        publicClient: {
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "getClients") return [CLIENT_A];
            if (functionName === "readFeedback") throw new Error("revert");
            throw new Error("unexpected");
          },
        },
      },
    },
  );
  assert.deepEqual(result, { error: "feedback_not_found" });
});

test("resolveClientForIndex の締切 → ambiguous_feedback_index", async () => {
  const manyClients = Array.from({ length: 30 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}` as Address);
  const result = await runErc8004Check(
    { agentId: "1", feedbackIndex: "1" },
    {
      readers: {
        publicClient: {
          readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
            if (functionName === "getClients") return manyClients;
            if (functionName === "readFeedback") {
              const who = String(args?.[1]).toLowerCase();
              if (who === manyClients[0]!.toLowerCase()) return [1n, 0, "", "", false];
              throw new Error("revert");
            }
            throw new Error("unexpected");
          },
        },
      },
    },
  );
  assert.deepEqual(result, { error: "ambiguous_feedback_index" });
});
function sliceWithUri(feedbackURI: string): FeedbackLogSlice {
  return {
    clientAddress: CLIENT_A,
    feedbackIndex: INDEX,
    value: 100n,
    valueDecimals: 0,
    tag1: "tag-a",
    tag2: "",
    endpoint: "",
    feedbackURI,
    feedbackHash: ZERO_HASH,
    blockNumber: 1n,
    txHash: ZERO_HASH,
  };
}

test("feedbackURI が空 → no_proof・no_feedback_uri（unreadable にしない）", async () => {
  let fetched = 0;
  const result = await runErc8004Check(
    { agentId: "1", client: CLIENT_A, feedbackIndex: "1" },
    {
      readers: metaReader([CLIENT_A]),
      findFeedbackLog: async () => sliceWithUri(""),
      fetchFeedbackUri: async () => {
        fetched += 1;
        return { body: "{}", contentType: "application/json" };
      },
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "no_proof");
  assert.equal(result.no_proof_reason, "no_feedback_uri");
  assert.equal(result.unreadable_reason, undefined);
  assert.equal(fetched, 0);
});

test("feedbackURI が読めない → unreadable・feedback_uri_unreadable", async () => {
  const result = await runErc8004Check(
    { agentId: "1", client: CLIENT_A, feedbackIndex: "1" },
    {
      readers: metaReader([CLIENT_A]),
      findFeedbackLog: async () => sliceWithUri("https://example.invalid/feedback.json"),
      fetchFeedbackUri: async () => {
        throw new Error("fetch failed");
      },
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "unreadable");
  assert.equal(result.unreadable_reason, "feedback_uri_unreadable");
});
