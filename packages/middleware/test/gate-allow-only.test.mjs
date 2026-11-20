import test from "node:test";
import assert from "node:assert/strict";
import { createTrustGate } from "../dist/core.js";
import { createSellerEdge } from "../dist/seller-edge.js";

const ADDR = "0x3333333333333333333333333333333333333333";

test("allow-only blocks unknown recommendation words", async () => {
  const gate = createTrustGate({
    apiUrl: "https://api.stub",
    apiKey: "stub",
    fetch: async () => new Response(JSON.stringify({ recommendation: "UNKNOWN", trustScore: 10 }), { status: 200 }),
  });
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "recommendation_not_allow");
});

test("minScore with null score blocks", async () => {
  const gate = createTrustGate({
    apiUrl: "https://api.stub",
    apiKey: "stub",
    minScore: 90,
    fetch: async () => new Response(JSON.stringify({ recommendation: "ALLOW" }), { status: 200 }),
  });
  const d = await gate.evaluate(ADDR);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "score_unavailable");
});

test("seller edge replay delivers once under concurrency", async () => {
  const offer = {
    amount: "10000",
    payTo: ADDR,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    network: "eip155:8453",
  };
  const tx = "0x" + "ef".repeat(32);
  const edge = createSellerEdge({
    offer,
    readChain: async () => ({ txHash: tx, ...offer }),
    signDelivery: async () => "sig",
    recordE6: async () => {},
  });
  const receipt = { valid: true, txHash: tx, ...offer };
  const run = (id) => edge.run({ purchaseId: id, receipt }, async () => ({ status: 200, body: "ok" }));
  const [a, b] = await Promise.all([run("p1"), run("p2")]);
  const delivered = [a, b].filter((r) => r.delivered).length;
  assert.equal(delivered, 1);
});