// MCP check_concordium_agent（2026-11-22・WORK_ORDERS「本番の MCP に Concordium の判定を1つの道具として足す」）。
// 完了条件の 1〜5 を、実物の /check の応答（2026-11-22 取得の fixture）と差し替えの fetch で固定する。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import { checkConcordiumAgentOutput } from "@/lib/mcp/schemas";
import { CONCORDIUM_CHECK_ORIGIN } from "@/lib/mcp/concordium";
import { parseBody } from "./mcp-route.test";

delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

const FIX = (agent: string) => readFileSync(join(process.cwd(), `tests/fixtures/concordium-check-${agent}.json`), "utf8");
let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq % 250}`;

function deps(concordiumFetch: typeof fetch) {
  return {
    resolve: (async () => ({ resource: null, endpoints: [] })) as never,
    decide: (async () => ({})) as never,
    l1Purchases: async () => [],
    sellerPage: {} as never,
    hostExtras: async () => ({}) as never,
    findAlternatives: async () => ({ fetchedAt: "2026-11-22T00:00:00.000Z", listings: [] }),
    findUntested: async () => [],
    concordiumFetch,
  };
}

const fixtureFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin, CONCORDIUM_CHECK_ORIGIN);
  assert.equal(url.searchParams.get("caller"), "vet402.com-mcp");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["agent", "caller"], "only agent and caller are sent");
  return new Response(FIX(url.searchParams.get("agent") ?? ""), { status: 200, headers: { "content-type": "application/json" } });
};

async function call(method: string, params: Record<string, unknown>) {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(
    new NextRequest("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "x-real-ip": freshIp(),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    }),
  );
  const text = await res.text();
  return { res, json: parseBody(res.headers.get("content-type") ?? "", text) as { result?: Record<string, unknown> } };
}

const callAgent = (agent: string) => call("tools/call", { name: "check_concordium_agent", arguments: { agent } });

afterEach(() => setMcpDepsForTest(null));

test("1: tools/list carries check_concordium_agent", async () => {
  setMcpDepsForTest(deps(fixtureFetch));
  const { json } = await call("tools/list", {});
  const names = ((json.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes("check_concordium_agent"), names.join(","));
});

test("2: agent 1350 → badge go, verdict no, the line says not delivered, testnet stated", async () => {
  setMcpDepsForTest(deps(fixtureFetch));
  const { res, json } = await callAgent("1350");
  assert.equal(res.status, 200);
  const out = checkConcordiumAgentOutput.parse(json.result?.structuredContent);
  assert.equal(out.badge_status, "go");
  assert.equal(out.verdict, "no");
  assert.match(out.trust_summary ?? "", /not delivered/);
  assert.equal(out.network, "concordium-testnet");
  assert.match(out.note, /testnet/);
  assert.match(out.row_url ?? "", /^https:\/\/ccdexplorer\.io\/testnet\/transaction\//);
});

test("3: agent 990 (a third-party seller) → go", async () => {
  setMcpDepsForTest(deps(fixtureFetch));
  const { json } = await callAgent("990");
  const out = checkConcordiumAgentOutput.parse(json.result?.structuredContent);
  assert.equal(out.verdict, "go");
  assert.equal(out.badge_status, "go");
});

test("4: unknown agent 99999999 → unproven, the server keeps answering", async () => {
  setMcpDepsForTest(deps(fixtureFetch));
  const { res, json } = await callAgent("99999999");
  assert.equal(res.status, 200);
  const out = checkConcordiumAgentOutput.parse(json.result?.structuredContent);
  assert.equal(out.verdict, "unproven");
  assert.equal(out.row_url, null);
  // 次の呼び出しも普通に答える（落ちていない）。
  const again = await callAgent("990");
  assert.equal(again.res.status, 200);
});

test("4b: a malformed agent is an input error, Concordium is not called", async () => {
  let called = 0;
  setMcpDepsForTest(deps((async () => { called += 1; return new Response("{}"); }) as typeof fetch));
  const { json } = await callAgent("1350; drop");
  const r = json.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /invalid_concordium_agent/);
  assert.equal(called, 0);
});

test("5: Concordium unreachable → concordium_unavailable, HTTP 200 (not a vet402 outage), other tools unaffected", async () => {
  setMcpDepsForTest(deps((async () => { throw new TypeError("fetch failed"); }) as typeof fetch));
  const t0 = Date.now();
  const { res, json } = await callAgent("1350");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(res.status, 200, "a Concordium outage must not turn the MCP answer into 503");
  const r = json.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /concordium_unavailable/);
  const list = await call("tools/list", {});
  assert.equal(list.res.status, 200);
});

test("5b: an answer that is not the expected shape is concordium_unavailable", async () => {
  setMcpDepsForTest(deps((async () => new Response('{"oops":true}', { status: 200 })) as typeof fetch));
  const { json } = await callAgent("1350");
  assert.match((json.result as { content: { text: string }[] }).content[0].text, /concordium_unavailable/);
});
