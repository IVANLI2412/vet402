// FIX_R2 B-006, B-007/B-008, C-10 (no DATABASE_URL).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { __setErc8004CheckCacheForTests } from "@/lib/erc8004-check/cache";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import { parseBody } from "./mcp-route.test";
import { ERROR_TEXT } from "@/lib/mcp/text";

delete process.env.DATABASE_URL;

afterEach(() => {
  __setErc8004CheckCacheForTests(null);
  setMcpDepsForTest(null);
});

test("B-006: erc8004 cache throw → REST 503 and MCP HTTP 503", async () => {
  __setErc8004CheckCacheForTests((() => {
    throw new Error("cache layer failed");
  }) as never);

  const { GET: restGet } = await import("@/app/api/v1/erc8004/check/route");
  const rest = await restGet(new NextRequest("http://localhost/api/v1/erc8004/check?agentId=1&client=0x" + "11".repeat(20)));
  assert.equal(rest.status, 503);
  assert.deepEqual(await rest.json(), { error: "chain_unreadable" });

  setMcpDepsForTest({
    resolve: (async () => ({ resource: null, endpoints: [] })) as never,
    decide: (async () => ({})) as never,
    l1Purchases: async () => [],
    sellerPage: {} as never,
    hostExtras: async () => ({}) as never,
    findAlternatives: async () => ({ fetchedAt: new Date().toISOString(), listings: [] }),
    findUntested: async () => [],
    erc8004Check: (async () => {
      throw new Error("cache layer failed");
    }) as never,
  });

  const { POST } = await import("@/app/api/mcp/route");
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "check_8004_agent", arguments: { agentId: "1", client: "0x" + "11".repeat(20), feedbackIndex: "1" } },
  };
  const res = await POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "x-real-ip": "192.0.2.4",
      },
      body: JSON.stringify(body),
    }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "temporarily_unavailable" });
});

test("B-007/B-008: watch route returns 503 on DB errors instead of 500 or false ok", () => {
  const src = readFileSync("src/app/api/v1/observatory/watch/route.ts", "utf8");
  assert.match(src, /observatory_watch_get/);
  assert.doesNotMatch(src, /if \(!isMissingSchemaError\(error\)\) throw error/);
  assert.match(src, /error: "service_unavailable".*status: 503/s);
  assert.doesNotMatch(src, /isMissingSchemaError\(error\)\) {\s*return withRateLimitHeaders\(\s*NextResponse\.json\(\{ ok: true \}/);
});

test("C-10: MCP feedbackIndex 0 matches REST positive-integer message", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const args = { agentId: "1", client: "0x" + "33".repeat(20), feedbackIndex: 0 };
  const body = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_8004_agent", arguments: args } };
  const res = await POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "x-real-ip": "192.0.2.5",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  const json = parseBody(res.headers.get("content-type") ?? "", text);
  const result = json.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const err = JSON.parse(result.content[0].text) as { error: string; message?: string };
  assert.equal(err.error, "invalid_feedback_index");
  assert.equal(err.message, ERROR_TEXT.invalid_feedback_index);
});