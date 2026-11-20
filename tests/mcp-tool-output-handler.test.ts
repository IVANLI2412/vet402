// B-009: MCP tool return values must satisfy outputSchema (handler functions).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import { checkEndpointOutput, checkPaymentProofOutput, findSellersOutput } from "@/lib/mcp/schemas";
import { findSellers, runCheckPaymentProof, type McpDeps } from "@/lib/mcp/tools";
import { readFileSync } from "node:fs";

delete process.env.DATABASE_URL;

afterEach(() => setMcpDepsForTest(null));

const BASE_DEPS = {
  resolve: (async () => ({ resource: null, endpoints: [] })) as never,
  decide: (async () => ({})) as never,
  l1Purchases: async () => [],
  sellerPage: {} as never,
  hostExtras: async () => ({}) as never,
  findAlternatives: async () => ({ fetchedAt: "2026-11-20T00:00:00.000Z", listings: [] }),
  findUntested: async () => [],
  erc8004Check: async () => ({ error: "invalid_agent_id" as const }),
};

test("findSellers return value satisfies findSellersOutput", async () => {
  setMcpDepsForTest({
    ...BASE_DEPS,
    findAlternatives: async () => ({
      fetchedAt: "2026-11-20T00:00:00.000Z",
      listings: [
        {
          resource_id: "a".repeat(64),
          url: "https://example.com/v1",
          host: "example.com",
          pay_to: "0x" + "11".repeat(20),
          score: 82,
          recommendation: "ALLOW",
        },
      ],
    }),
  });
  const out = await findSellers(BASE_DEPS as never, { query: "weather" });
  assert.notEqual(out, "invalid_query");
  const parsed = findSellersOutput.safeParse(out);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
});

test("check_my_x402_endpoint tools/call uses checkEndpointOutput on success objects", () => {
  const src = readFileSync("src/lib/mcp/tools.ts", "utf8");
  const block = src.slice(src.indexOf("TOOL_NAMES.checkEndpoint"), src.indexOf("TOOL_NAMES.checkPayment"));
  assert.match(block, /outputSchema: checkEndpointOutput/);
  assert.match(block, /const out = await checkEndpoint/);
  const minimal = {
    host: "weather.shop.example",
    on_record: false,
    page_kind: "none",
    listed_in: [],
    listing_sources: [],
    l0: null,
    l1: null,
    l1_failure_modes: [],
    listings: [],
    l1_purchases: [],
    fix_first_url: null,
    notes: [],
    record_url: null,
    method_url: "https://vet402.com/sellers/{host}/fix-first",
    as_of: "2026-11-20T00:00:00.000Z",
    truncated: false,
  };
  assert.ok(checkEndpointOutput.safeParse(minimal).success);
});

test("runCheckPaymentProof return value satisfies checkPaymentProofOutput", async () => {
  const payment_response = Buffer.from(
    JSON.stringify({
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: "eip155:8453",
      payer: "0x1111111111111111111111111111111111111111",
    }),
    "utf8",
  ).toString("base64");
  const out = await runCheckPaymentProof(
    { payment_response, transaction: `0x${"ab".repeat(32)}` },
    {
      now: () => new Date("2026-11-12T00:00:00.000Z"),
      readers: {
        evm: () => ({
          getChainId: async () => 8453,
          getBlockNumber: async () => 500n,
          getBlock: async () => ({ timestamp: 1_700_000_000n, number: 123n }),
          getTransactionReceipt: async () => ({ status: "success", blockNumber: 123n, logs: [] }),
        }),
      },
    } as never,
  );
  const parsed = checkPaymentProofOutput.safeParse(out);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
});