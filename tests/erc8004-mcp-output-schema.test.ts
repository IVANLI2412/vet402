// REST の check が返す形を、MCP の outputSchema（.strict()）がそのまま受けるか。
// 2026-11-20: no_proof_reason を足したとき outputSchema に無く、MCP だけが
// "Unrecognized key" で isError になった。その再発を止める。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import type { FeedbackLogSlice } from "@/lib/erc8004-check/registry-read";
import { runErc8004Check } from "@/lib/erc8004-check/run-check";
import { ERC8004_NO_PROOF_REASONS, ERC8004_UNREADABLE_REASONS, type Erc8004CheckResult } from "@/lib/erc8004-check/types";
import { check8004AgentOutput } from "@/lib/mcp/schemas";

delete process.env.DATABASE_URL;

const CLIENT = "0x397558E5D63a894934362E5c3C33Ab5d0170c228" as Address;
const ZERO = `0x${"00".repeat(32)}` as Hex;

const readers = {
  publicClient: {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getClients") return [CLIENT];
      if (functionName === "readFeedback") return [100n, 0, "tag-a", "", false];
      throw new Error(`unexpected ${functionName}`);
    },
  },
};

function slice(feedbackURI: string): FeedbackLogSlice {
  return {
    clientAddress: CLIENT, feedbackIndex: 1n, value: 100n, valueDecimals: 0, tag1: "tag-a", tag2: "",
    endpoint: "", feedbackURI, feedbackHash: ZERO, blockNumber: 1n, txHash: ZERO,
  };
}

function assertMcpAccepts(result: Erc8004CheckResult | { error: string }, label: string) {
  assert.ok(!("error" in result), `${label}: ${JSON.stringify(result)}`);
  const parsed = check8004AgentOutput.safeParse(result);
  assert.ok(parsed.success, `${label}: ${parsed.success ? "" : parsed.error.message}`);
}

test("no_proof（feedbackURI が空）を MCP の outputSchema が受ける", async () => {
  const r = await runErc8004Check({ agentId: "1", client: CLIENT, feedbackIndex: "1" }, { readers, findFeedbackLog: async () => slice("") });
  assertMcpAccepts(r, "no_feedback_uri");
});

test("unreadable（feedbackURI が読めない）を MCP の outputSchema が受ける", async () => {
  const r = await runErc8004Check(
    { agentId: "1", client: CLIENT, feedbackIndex: "1" },
    { readers, findFeedbackLog: async () => slice("https://example.invalid/f.json"), fetchFeedbackUri: async () => { throw new Error("x"); } },
  );
  assertMcpAccepts(r, "feedback_uri_unreadable");
});

test("unreadable（発行記録の走査が締切）を MCP の outputSchema が受ける", async () => {
  const r = await runErc8004Check({ agentId: "1", client: CLIENT, feedbackIndex: "1" }, { readers, findFeedbackLog: async () => ({ kind: "deadline" as const }) });
  assertMcpAccepts(r, "feedback_log_not_found_in_time");
});

test("no_proof（ファイルに支払いが無い）を MCP の outputSchema が受ける", async () => {
  const r = await runErc8004Check(
    { agentId: "1", client: CLIENT, feedbackIndex: "1" },
    { readers, findFeedbackLog: async () => slice("https://example.invalid/f.json"), fetchFeedbackUri: async () => ({ body: "{}", contentType: "application/json" }) },
  );
  // feedbackHash が一致しない形でも mismatch・no_proof どちらでも MCP が受けることを見る
  assertMcpAccepts(r, "body without proof");
});

test("REST が返しうる理由の全部を MCP の outputSchema が受ける", () => {
  const base = check8004AgentOutput.shape;
  for (const r of ERC8004_UNREADABLE_REASONS) assert.ok(base.unreadable_reason.safeParse(r).success, r);
  for (const r of ERC8004_NO_PROOF_REASONS) assert.ok(base.no_proof_reason.safeParse(r).success, r);
});

test("Erc8004CheckResult のキーはすべて check8004AgentOutput の shape にある", () => {
  const schemaKeys = new Set(Object.keys(check8004AgentOutput.shape));
  const resultKeys = [
    "verdict",
    "reasons",
    "unreadable_reason",
    "no_proof_reason",
    "chain",
    "agentId",
    "clientAddress",
    "feedbackIndex",
    "feedback",
    "proofOfPayment",
    "checks",
    "sources",
    "as_of",
  ] as const;
  for (const key of resultKeys) {
    assert.ok(schemaKeys.has(key), `check8004AgentOutput.shape に ${key} が無い`);
  }
});
