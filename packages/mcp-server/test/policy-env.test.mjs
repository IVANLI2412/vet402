import test from "node:test";
import assert from "node:assert/strict";
import {
  mergePolicyFromEnv,
  policyFromEnv,
  resetSessionSpendForTests,
  sessionCapUsd,
  tryReserveSessionSpend,
  releaseSessionSpend,
} from "../dist/policy-env.js";

test("tool cannot waive vet402 when env requires ALLOW", () => {
  const env = policyFromEnv({});
  const merged = mergePolicyFromEnv(env, { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } });
  assert.equal(merged.requireVet402Allow, true);
});

test("default env merges tool evidence floors", () => {
  const env = policyFromEnv({});
  const merged = mergePolicyFromEnv(env, {
    evidence: { source: "both", minL1Deliveries: 5, minSubgraphReceipts: 3 },
  });
  assert.equal(merged.requireVet402Allow, true);
  assert.equal(merged.evidence?.minL1Deliveries, 5);
  assert.equal(merged.evidence?.minSubgraphReceipts, 3);
  // 11/22 証明の監査 R5-1/N4: tool の both は捨てずに残す（前は vet402 に落ち、assertPolicy が拒否する組み合わせだった）。
  assert.equal(merged.evidence?.source, "both");
});

test("source takes the strictest side: same stays, different becomes both", () => {
  const env = policyFromEnv({});
  assert.equal(mergePolicyFromEnv(env, { evidence: { source: "vet402" } }).evidence?.source, "vet402");
  assert.equal(mergePolicyFromEnv(env, { evidence: { source: "subgraph", minSubgraphReceipts: 3 } }).evidence?.source, "both");
  assert.equal(mergePolicyFromEnv(env, { evidence: { source: "both" } }).evidence?.source, "both");
  assert.equal(mergePolicyFromEnv(env, {}).evidence, undefined);
});

test("waive env takes max L1 floor from tool when tool requires vet402 ALLOW", () => {
  const env = policyFromEnv({ VOUCH_ALLOW_WAIVE_VET402: "true", VOUCH_MIN_L1_DELIVERIES: "1" });
  const merged = mergePolicyFromEnv(env, { requireVet402Allow: true, evidence: { minL1Deliveries: 5 } });
  assert.equal(merged.requireVet402Allow, true);
  assert.equal(merged.evidence?.minL1Deliveries, 5);
});

test("session cumulative cap defaults to 10x single-tx ceiling", () => {
  resetSessionSpendForTests();
  const cap = sessionCapUsd(undefined);
  assert.equal(cap, 10);
  assert.equal(tryReserveSessionSpend(1, cap), true);
  assert.equal(tryReserveSessionSpend(9, cap), true);
  assert.equal(tryReserveSessionSpend(1, cap), false);
});

test("parallel reserve matches signed total cap", async () => {
  resetSessionSpendForTests();
  const cap = sessionCapUsd(undefined);
  let signedTotal = 0;
  async function call(amount) {
    if (!tryReserveSessionSpend(amount, cap)) return "refused";
    await new Promise((r) => setTimeout(r, 5));
    signedTotal += amount;
    return "paid";
  }
  const out = await Promise.all(Array.from({ length: 30 }, () => call(1)));
  assert.equal(out.filter((x) => x === "paid").length, 10);
  assert.equal(out.filter((x) => x === "refused").length, 20);
  assert.equal(signedTotal, 10);
});

test("unsigned attempt releases reservation", () => {
  resetSessionSpendForTests();
  const cap = 10;
  assert.equal(tryReserveSessionSpend(3, cap), true);
  releaseSessionSpend(3);
  assert.equal(tryReserveSessionSpend(10, cap), true);
});