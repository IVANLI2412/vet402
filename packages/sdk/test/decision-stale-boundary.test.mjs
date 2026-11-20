import test from "node:test";
import assert from "node:assert/strict";
import { payOrRefuse } from "../dist/index.js";

const GOOD = "0x1111111111111111111111111111111111111111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://good-seller.example/api/data";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const baseDecision = (over = {}) => ({
  recommendation: "ALLOW",
  reason_codes: ["l0_pass"],
  degraded: false,
  facts: {},
  evidence: [],
  rules_version: "stub",
  verified_terms: {
    purchase_id: "p1",
    pay_to: GOOD,
    asset: USDC,
    amount: "10000",
    decimals: 6,
    network: "eip155:8453",
    scheme: "exact",
    protocol: "x402",
    verified_at: "2026-11-20T00:00:00Z",
  },
  ...over,
});

function world(decision) {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const paid = new Headers(init.headers).has("payment-signature");
    if (url.includes("/resolve")) return new Response(JSON.stringify({ resource: { resource_id: "a".repeat(64) } }));
    if (url.includes("/decision")) return new Response(JSON.stringify(decision), { status: 200 });
    if (url.includes("/payments/x402")) return new Response("{}");
    if (!paid) {
      return new Response(null, {
        status: 402,
        headers: {
          "payment-required": b64({
            x402Version: 2,
            accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: GOOD }],
          }),
        },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32) }) },
    });
  };
}

const account = {
  address: "0x3333333333333333333333333333333333333333",
  signTypedData: async () => "0x" + "00".repeat(65),
};

test("C/D/E: boundary freshness within 60s skew still pays", async () => {
  const now = Date.now();
  for (const decision of [
    baseDecision({
      scoredAt: new Date(now - 299_000).toISOString(),
      cacheExpiresAt: new Date(now + 120_000).toISOString(),
    }),
    baseDecision({
      scoredAt: new Date(now - 299_990).toISOString(),
      cacheExpiresAt: new Date(now - 50).toISOString(),
    }),
    baseDecision({ scoredAt: new Date(now - 60_000).toISOString(), cacheExpiresAt: new Date(now + 60_000).toISOString() }),
  ]) {
    const r = await payOrRefuse({
      payee: GOOD,
      resource: RESOURCE,
      amountUsd: 0.01,
      account,
      fetch: world(decision),
    });
    assert.equal(r.status, "paid", JSON.stringify(decision));
  }
});

test("scoredAt 6 minutes old stays refused as decision_stale after one refetch", async () => {
  let hits = 0;
  const stale = baseDecision({
    scoredAt: new Date(Date.now() - 360_000).toISOString(),
    cacheExpiresAt: new Date(Date.now() - 120_000).toISOString(),
  });
  const fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/decision")) {
      hits += 1;
      return new Response(JSON.stringify(stale), { status: 200 });
    }
    return world(stale)(input, init);
  };
  const r = await payOrRefuse({ payee: GOOD, resource: RESOURCE, amountUsd: 0.01, account, fetch });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("decision_stale"));
  assert.equal(hits, 2);
});