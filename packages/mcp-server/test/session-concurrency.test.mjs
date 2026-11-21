// adversary-1 / whitehat-2: session cap and one live authorization per resource under parallel calls.
import test from "node:test";
import assert from "node:assert/strict";
import { payIfTrusted } from "../dist/pay-if-trusted.js";
import { resetSessionSpendForTests, tryReserveSessionSpend, sessionCapUsd } from "../dist/policy-env.js";
import { allowDecisionBody } from "./helpers/decision.mjs";

const PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
};
const RESOURCE = "https://gateway.example/api/data";
const b64 = (o) => btoa(JSON.stringify(o));

function seller() {
  let n = 0;
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) {
      return { ok: true, status: 200, json: async () => allowDecisionBody(ACCEPT), headers: new Map() };
    }
    if (u.includes("/resolve")) {
      return { ok: true, status: 200, json: async () => ({ resource: { resource_id: "a".repeat(64) } }), headers: new Map() };
    }
  if (u.includes("/payments/x402")) return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    const paid = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
    if (!paid) {
      return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [ACCEPT] })]]) };
    }
    n += 1;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: false, status: 500, json: async () => ({}), headers: new Map() };
  };
}

test("parallel pay_if_trusted on one resource signs at most once", async () => {
  let signs = 0;
  const signer = {
    address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
    signTypedData: async () => {
      signs += 1;
      await new Promise((r) => setTimeout(r, 30));
      return "0x" + "11".repeat(65);
    },
  };
  const fetch = seller();
  const base = {
    resourceId: "a".repeat(64),
    signer,
    fetch,
    apiUrl: "https://api.stub",
    resource: RESOURCE,
    payee: PAYEE,
    amountUsd: 0.01,
    maxPerTxUsd: 1,
  };
  const [a, b] = await Promise.all([payIfTrusted(base), payIfTrusted(base)]);
  assert.equal(signs, 1, `signed ${signs} times`);
  const decisions = [a.decision, b.decision];
  assert.ok(decisions.includes("FAILED") || decisions.includes("REFUSE"));
  assert.ok(decisions.filter((d) => d === "FAILED").length <= 1);
});

test("session reserve under Promise.all matches floor(cap/amount)", async () => {
  resetSessionSpendForTests();
  const cap = sessionCapUsd("10");
  const amount = 1;
  let paid = 0;
  async function attempt() {
    if (!tryReserveSessionSpend(amount, cap)) return "refused";
    await new Promise((r) => setTimeout(r, 3));
    paid += amount;
    return "ok";
  }
  const out = await Promise.all(Array.from({ length: 25 }, () => attempt()));
  assert.equal(out.filter((x) => x === "ok").length, 10);
  assert.equal(paid, 10);
  resetSessionSpendForTests();
});