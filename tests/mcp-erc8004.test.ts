// MCP check_8004_agent — runErc8004Check をそのまま呼ぶ（HTTP 自己呼び出しなし）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, pad, toBytes, type Address, type Hex } from "viem";
import { hashFeedbackBody } from "@/lib/erc8004-check/feedback-uri";
import type { FeedbackLogSlice } from "@/lib/erc8004-check/registry-read";
import { runErc8004Check } from "@/lib/erc8004-check/run-check";
import { check8004Agent } from "@/lib/mcp/tools";
import { BASE_USDC } from "@/lib/observatory/x402-payer";

delete process.env.DATABASE_URL;

const CLIENT = "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a" as Address;
const PAYEE = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const TX = `0x${"cc".repeat(32)}` as Hex;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicAddr(addr: string): Hex {
  return pad(addr as Hex, { size: 32 });
}

function feedbackJson(proof: Record<string, unknown> | null): string {
  return JSON.stringify({ type: "ars-evidence/0.1", proofOfPayment: proof });
}

function makeLogSlice(body: string): FeedbackLogSlice {
  return {
    clientAddress: CLIENT,
    feedbackIndex: 1n,
    value: 100n,
    valueDecimals: 0,
    tag1: "reachable",
    tag2: "",
    endpoint: "https://agent402.tools/",
    feedbackURI: "data:application/json;base64," + Buffer.from(body, "utf8").toString("base64"),
    feedbackHash: hashFeedbackBody(body),
    blockNumber: 56_000_000n,
    txHash: TX,
  };
}

function registryReader() {
  return {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getClients") return [CLIENT];
        if (functionName === "getLastIndex") return 1n;
        if (functionName === "readFeedback") return [100n, 0, "reachable", "", false];
        throw new Error("unexpected");
      },
    },
  };
}

function baseDeps(logSlice: FeedbackLogSlice) {
  return {
    readers: registryReader(),
    findFeedbackLog: async () => logSlice,
    resolvePayTargets: async () => ({
      owner: PAYEE,
      agentWallet: PAYEE,
      vet402PayTo: PAYEE,
      matchKind: "owner" as const,
    }),
    fetchFeedbackUri: async (uri: string) => ({
      body: Buffer.from(uri.split(",")[1], "base64").toString("utf8"),
      contentType: "application/json",
    }),
    paymentReaders: {
      evm: async () => ({
        getChainId: async () => 8453,
        getBlockNumber: async () => 1n,
        getBlock: async () => ({ timestamp: 1_731_000_000n, number: 123n }),
        getTransactionReceipt: async () => ({
          status: "success",
          blockNumber: 123n,
          logs: [
            {
              address: BASE_USDC,
              topics: [TRANSFER, topicAddr(CLIENT), topicAddr(PAYEE)],
              data: `0x${(10_000n).toString(16).padStart(64, "0")}`,
            },
          ],
        }),
      }),
    },
  };
}

test("MCP check_8004_agent は verified を返す", async () => {
  const body = feedbackJson({
    txHash: TX,
    chain: "eip155:8453",
    fromAddress: CLIENT,
    toAddress: PAYEE,
    amount: "10000",
  });
  const run = (input: Parameters<typeof runErc8004Check>[0]) =>
    runErc8004Check(input, baseDeps(makeLogSlice(body)) as never);
  const out = await check8004Agent({ erc8004Check: run } as never, {
    agentId: "94639",
    client: CLIENT,
    feedbackIndex: "1",
  });
  assert.ok(!("error" in out));
  assert.equal(out.verdict, "verified");
});

test("MCP check_8004_agent — agentId 欠落は呼び出しで invalid_agent_id", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const { NextRequest } = await import("next/server");
  const V2025 = "2025-06-18";
  const send = async (body: unknown) => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": V2025,
          "x-real-ip": "192.0.2.5",
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text) as { result: { isError?: boolean; content: { text: string }[] } };
  };
  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: V2025, capabilities: {}, clientInfo: { name: "t", version: "1.0.0" } },
  });
  const r = await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "check_8004_agent", arguments: { client: CLIENT } },
  });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /invalid_agent_id/);
});

test("MCP check_8004_agent — unreadable", async () => {
  const body = feedbackJson({ txHash: TX, chain: "eip155:8453" });
  const slice = makeLogSlice(body);
  slice.feedbackURI = "https://example.invalid/missing.json";
  const run = (input: Parameters<typeof runErc8004Check>[0]) =>
    runErc8004Check(input, {
      ...baseDeps(slice),
      fetchFeedbackUri: async () => {
        throw new Error("http_404");
      },
    } as never);
  const out = await check8004Agent({ erc8004Check: run } as never, {
    agentId: "94639",
    client: CLIENT,
    feedbackIndex: "1",
  });
  assert.ok(!("error" in out));
  assert.equal(out.verdict, "unreadable");
});

test("check_8004_agent が公開面の一覧に載る", async () => {
  const { readFileSync } = await import("node:fs");
  const llms = readFileSync("public/llms.txt", "utf8");
  assert.ok(llms.includes("check_8004_agent"));
  const install = readFileSync("llms-install.md", "utf8");
  assert.ok(install.includes("check_8004_agent"));
});