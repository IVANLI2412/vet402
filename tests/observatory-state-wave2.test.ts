import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { unstable_cache } from "next/cache";
import { SELLER_RETEST_REQUEST_SOURCE } from "@/lib/observatory/seller-retest-requests";
import { EVM_LANE_ENDPOINT_SOURCE } from "@/lib/observatory/evm-lane-ingest";
import { __setSettlementIndexCacheForTests } from "@/lib/observatory/settlement-index-status";

test("state API adds wave2 keys", async (t) => {
  t.mock.method(console, "error", () => {});
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state", { headers: { "x-forwarded-for": "203.0.113.90" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.coverage7dDefinition);
  assert.match(body.coverage7dDefinition, new RegExp(SELLER_RETEST_REQUEST_SOURCE));
  assert.match(body.coverage7dDefinition, new RegExp(EVM_LANE_ENDPOINT_SOURCE));
  assert.deepEqual(Object.keys(body.coverage7d ?? {}).sort(), ["activeEndpoints", "measuredLast7d", "pct"]);
  assert.ok(body.settlementIndex?.status);
  assert.ok(body.catalogSourcesNotRead?.some((r: { source: string }) => r.source === "x402scan_resources"));
  assert.equal(body.catalogSourcesNotRead.find((r: { source: string }) => r.source === "x402scan_resources")?.reason, "paid_read");
  assert.ok(body.settlementIndex);
  const payai = body.catalogSnapshots?.find((s: { source: string }) => s.source === "payai_discovery");
  assert.ok(payai);
  assert.equal(payai.status, "not_yet_read");
  assert.equal(payai.totalCount, null);
  assert.match(body.disclaimer, /catalogSourcesNotRead/);
});

test("state API returns settlementIndex unavailable without byChain when index read fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const identityCache = ((fn: () => Promise<unknown>) => fn) as typeof unstable_cache;
  const unavailable = async () => ({
    status: "unavailable" as const,
    reason: "read_failed" as const,
    readAt: "2026-11-15T00:00:00.000Z",
  });
  __setSettlementIndexCacheForTests(identityCache, unavailable);
  t.after(() => {
    __setSettlementIndexCacheForTests(null);
  });
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/observatory/state", { headers: { "x-forwarded-for": "203.0.113.91" } }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.settlementIndex?.status, "unavailable");
  assert.equal("byChain" in (body.settlementIndex ?? {}), false);
});