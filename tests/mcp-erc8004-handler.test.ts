// MCP check_8004_agent — /api/mcp の tools/call 経路（outputSchema・structuredContent）。
// runErc8004Check の戻り形が handler で握りつぶされないことを、差し替え erc8004Check で固定する。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import type { Erc8004CheckResult } from "@/lib/erc8004-check/types";
import type { Erc8004CheckError, Erc8004CheckInput } from "@/lib/erc8004-check/run-check";
import { check8004AgentOutput } from "@/lib/mcp/schemas";
import { parseBody } from "./mcp-route.test";

delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

const CLIENT = "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a";
const AS_OF = "2026-11-20T00:00:00.000Z";

function baseResult(verdict: Erc8004CheckResult["verdict"], extra: Partial<Erc8004CheckResult> = {}): Erc8004CheckResult {
  return {
    verdict,
    chain: "eip155:8453",
    agentId: "94639",
    clientAddress: CLIENT,
    feedbackIndex: "1",
    feedback: {
      value: "100",
      valueDecimals: 0,
      tag1: "reachable",
      tag2: "",
      endpoint: "https://agent402.tools/",
      feedbackURI: "data:application/json;base64,e30=",
      feedbackHash: `0x${"aa".repeat(32)}`,
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
    sources: [{ kind: "reputation_registry", detail: "stub" }],
    as_of: AS_OF,
    ...extra,
  };
}

const STUBS: Record<string, Erc8004CheckResult | { error: Erc8004CheckError }> = {
  verified: baseResult("verified", {
    proofOfPayment: { txHash: `0x${"cc".repeat(32)}`, chain: "eip155:8453" },
    checks: {
      tx_exists: "pass",
      to_matches_agent_payTo_or_wallet: "pass",
      from_matches_client: "pass",
      amount: "pass",
      token: "pass",
      block_time: "pass",
      feedback_hash: "pass",
      proof_source: "proofOfPayment",
    },
  }),
  no_feedback_uri: baseResult("no_proof", { no_proof_reason: "no_feedback_uri", feedback: { ...baseResult("no_proof").feedback, feedbackURI: "" } }),
  no_proof_in_feedback: baseResult("no_proof", { no_proof_reason: "no_proof_in_feedback" }),
  feedback_log_not_found_in_time: baseResult("unreadable", { unreadable_reason: "feedback_log_not_found_in_time" }),
  feedback_uri_unreadable: baseResult("unreadable", { unreadable_reason: "feedback_uri_unreadable" }),
  proof_tx_not_found_on_known_chains: baseResult("unreadable", { unreadable_reason: "proof_tx_not_found_on_known_chains" }),
  mismatch: baseResult("mismatch", { reasons: ["amount"] }),
  verified_payment_unlinked_client: baseResult("verified_payment_unlinked_client"),
  ambiguous: { error: "ambiguous_feedback_index" },
};

let ipSeq = 0;
const freshIp = () => `192.0.2.${++ipSeq % 250}`;

async function postTool(agentId: string) {
  const { POST } = await import("@/app/api/mcp/route");
  const body = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "check_8004_agent", arguments: { agentId, client: CLIENT, feedbackIndex: "1" } },
  };
  const res = await POST(
    new NextRequest("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "x-real-ip": freshIp(),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { res, json: parseBody(res.headers.get("content-type") ?? "", text), text };
}

afterEach(() => setMcpDepsForTest(null));

test("handler 経路: runErc8004Check の成功分岐は isError ではなく structuredContent", async () => {
  const run = async (input: Erc8004CheckInput) => {
    const key = input.agentId ?? "verified";
    const stub = STUBS[key];
    assert.ok(stub, key);
    return stub;
  };
  setMcpDepsForTest({
    resolve: (async () => ({ resource: null, endpoints: [] })) as never,
    decide: (async () => ({})) as never,
    l1Purchases: async () => [],
    sellerPage: {} as never,
    hostExtras: async () => ({}) as never,
    findAlternatives: async () => ({ fetchedAt: AS_OF, listings: [] }),
    findUntested: async () => [],
    erc8004Check: run,
  });

  for (const key of [
    "verified",
    "no_feedback_uri",
    "no_proof_in_feedback",
    "feedback_log_not_found_in_time",
    "feedback_uri_unreadable",
    "proof_tx_not_found_on_known_chains",
    "mismatch",
    "verified_payment_unlinked_client",
  ]) {
    const { res, json } = await postTool(key);
    assert.equal(res.status, 200, key);
    const result = json.result as { isError?: boolean; structuredContent?: Erc8004CheckResult; content: { text: string }[] };
    assert.notEqual(result.isError, true, `${key}: ${JSON.stringify(result).slice(0, 200)}`);
    assert.ok(result.structuredContent, key);
    assert.equal(result.structuredContent!.verdict, STUBS[key] && "verdict" in STUBS[key]! ? (STUBS[key] as Erc8004CheckResult).verdict : "", key);
    const parsed = check8004AgentOutput.safeParse(result.structuredContent);
    assert.ok(parsed.success, `${key}: ${parsed.success ? "" : parsed.error.message}`);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});

test("handler 経路: ambiguous_feedback_index は isError で error を返す", async () => {
  setMcpDepsForTest({
    resolve: (async () => ({ resource: null, endpoints: [] })) as never,
    decide: (async () => ({})) as never,
    l1Purchases: async () => [],
    sellerPage: {} as never,
    hostExtras: async () => ({}) as never,
    findAlternatives: async () => ({ fetchedAt: AS_OF, listings: [] }),
    findUntested: async () => [],
    erc8004Check: async () => STUBS.ambiguous as { error: Erc8004CheckError },
  });
  const { res, json } = await postTool("ambiguous");
  assert.equal(res.status, 200);
  const result = json.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text) as { error: string };
  assert.equal(body.error, "ambiguous_feedback_index");
});

test("tools.ts の check_8004 handler は ok に Record へ cast する（戻すと型で止める）", () => {
  const src = readFileSync("src/lib/mcp/tools.ts", "utf8");
  const start = src.indexOf("TOOL_NAMES.check8004");
  assert.ok(start >= 0);
  const end = src.indexOf("if (!FIND_TOOL_ENABLED)", start);
  const block = src.slice(start, end);
  assert.match(block, /return ok\(out as unknown as Record<string, unknown>\)/);
});

test("check8004AgentOutput.shape に REST と揃える必須キーがある（schema から消すと別試験が落ちる）", () => {
  for (const key of ["no_proof_reason", "unreadable_reason", "reasons"] as const) {
    assert.ok(key in check8004AgentOutput.shape, key);
  }
  const sample = STUBS.no_feedback_uri as Erc8004CheckResult;
  assert.ok(check8004AgentOutput.safeParse({ ...sample, stray_key: true }).success === false);
});