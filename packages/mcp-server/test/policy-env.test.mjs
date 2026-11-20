import test from "node:test";
import assert from "node:assert/strict";
import { mergePolicyFromEnv, policyFromEnv, resetSessionSpendForTests, sessionCapUsd, chargeSessionSpend } from "../dist/policy-env.js";

test("tool cannot waive vet402 when env requires ALLOW", () => {
  const env = policyFromEnv({});
  const merged = mergePolicyFromEnv(env, { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } });
  assert.equal(merged.requireVet402Allow, true);
});

test("session cumulative cap defaults to 10x single-tx ceiling", () => {
  resetSessionSpendForTests();
  const cap = sessionCapUsd(undefined);
  assert.equal(cap, 10);
  assert.equal(chargeSessionSpend(1, cap), true);
  assert.equal(chargeSessionSpend(9, cap), true);
  assert.equal(chargeSessionSpend(1, cap), false);
});