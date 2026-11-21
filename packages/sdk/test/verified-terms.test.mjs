// adversary-1 / payaudit-08: verified_terms と facts.payees を 402 の accept と照合する。
import test from "node:test";
import assert from "node:assert/strict";
import { pay, payOrRefuse } from "../dist/index.js";

const GOOD = "0x1111111111111111111111111111111111111111";
const EVIL = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://good-seller.example/api/data";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const decisionBody = (terms, payees) => ({
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  degraded: false,
  facts: payees ? { payees } : {},
  evidence: [],
  rules_version: "stub",
  scoredAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  verified_terms: terms,
});

const challenge = (payTo, amount, extraAccepts = []) =>
  b64({
    x402Version: 2,
    accepts: [
      ...extraAccepts,
      { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo, maxTimeoutSeconds: 60 },
    ],
  });

function stubFetch(terms, payTo, amount, extra = []) {
  const termsDecision = decisionBody(terms);
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers);
    const paid = headers.has("payment-signature") || headers.has("x-payment");
    if (url.includes("/resolve")) {
      return new Response(JSON.stringify({ resource: { resource_id: "a".repeat(64) } }), { status: 200 });
    }
    if (url.includes("/decision")) return new Response(JSON.stringify(termsDecision), { status: 200 });
    if (url.includes("/payments/x402")) return new Response("{}");
    if (url === RESOURCE && !paid) {
      return new Response(null, { status: 402, headers: { "payment-required": challenge(payTo, amount, extra) } });
    }
    if (url === RESOURCE && paid) {
      return new Response("{}", {
        status: 200,
        headers: {
          "payment-response": b64({
            success: true,
            transaction: "0x" + "ab".repeat(32),
            network: "eip155:8453",
          }),
        },
      });
    }
    return new Response("{}", { status: 500 });
  };
}

const account = {
  address: "0x3333333333333333333333333333333333333333",
  signTypedData: async () => "0x" + "00".repeat(65),
};

const TERMS = {
  purchase_id: "p1",
  pay_to: GOOD,
  asset: USDC,
  amount: "10000",
  decimals: 6,
  network: "eip155:8453",
  scheme: "exact",
  protocol: "x402",
  verified_at: "2026-11-19T00:00:00Z",
};

test("V1 payee mismatch: verified_terms.pay_to と違う payTo → refused・署名0", async () => {
  const signed = [];
  const acc = {
    ...account,
    signTypedData: async (td) => {
      signed.push(td.message.to);
      return "0x" + "00".repeat(65);
    },
  };
  const r = await pay(RESOURCE, undefined, { account: acc, fetch: stubFetch(TERMS, EVIL, "1000000") });
  assert.equal(r.status, "refused");
  assert.equal(signed.length, 0);
  assert.ok(r.reasonCodes.includes("payee_mismatch"));
});

test("V2 price above declared: 額超過 → refused・署名0", async () => {
  const signed = [];
  const acc = { ...account, signTypedData: async () => (signed.push(1), "0x" + "00".repeat(65)) };
  const r = await payOrRefuse({
    payee: GOOD,
    resource: RESOURCE,
    amountUsd: 0.01,
    account: acc,
    fetch: stubFetch(TERMS, GOOD, "1000000"),
  });
  assert.equal(r.status, "refused");
  assert.equal(signed.length, 0);
  assert.ok(r.decision.reason_codes.includes("price_above_declared"));
});

test("V3 先頭に高い accept: 2件目が正しくても先頭が高額なら refused", async () => {
  const signed = [];
  const acc = { ...account, signTypedData: async () => (signed.push(1), "0x" + "00".repeat(65)) };
  const highFirst = [{ scheme: "exact", network: "eip155:8453", amount: "1000000", asset: USDC, payTo: GOOD }];
  const r = await payOrRefuse({
    payee: GOOD,
    resource: RESOURCE,
    amountUsd: 1,
    account: acc,
    fetch: stubFetch(TERMS, GOOD, "10000", highFirst),
  });
  assert.equal(r.status, "refused");
  assert.equal(signed.length, 0);
});

test("V4 ALLOW なのに verified_terms も payees も無い → refused", async () => {
  const fetch = stubFetch(null, GOOD, "10000");
  const stubFetchExplicitNull = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/decision")) {
      return new Response(
        JSON.stringify({ ...decisionBody(null), verified_terms: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return fetch(input, init);
  };
  const r = await payOrRefuse({
    payee: GOOD,
    resource: RESOURCE,
    amountUsd: 0.01,
    account,
    fetch: stubFetchExplicitNull,
  });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("evidence_unavailable"));
});

test("V4b ALLOW で verified_terms キーが無く payees も無い → refused", async () => {
  const fetch = stubFetch(TERMS, GOOD, "10000");
  const stubFetchNoKey = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/decision")) {
      const body = { ...decisionBody(TERMS) };
      delete body.verified_terms;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return fetch(input, init);
  };
  const r = await payOrRefuse({
    payee: GOOD,
    resource: RESOURCE,
    amountUsd: 0.01,
    account,
    fetch: stubFetchNoKey,
  });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("evidence_unavailable"));
});

const warnDecisionBody = (terms) => ({
  ...decisionBody(terms),
  recommendation: "WARN",
  reason_codes: ["l1_latest_failed"],
  facts: { l1: { n_delivered: 3, n_attempts: 4 } },
});

const waivePolicy = { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } };

test("V6 WARN 免除＋床＋verified_terms 超過 → refused・price_above_declared・署名0", async () => {
  const signed = [];
  const acc = { ...account, signTypedData: async () => (signed.push(1), "0x" + "00".repeat(65)) };
  const fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/decision")) {
      return new Response(JSON.stringify(warnDecisionBody(TERMS)), { status: 200 });
    }
    return stubFetch(TERMS, GOOD, "1000000")(input, init);
  };
  const r = await payOrRefuse({
    payee: GOOD,
    resource: RESOURCE,
    amountUsd: 1,
    account: acc,
    fetch,
    policy: waivePolicy,
  });
  assert.equal(r.status, "refused");
  assert.equal(signed.length, 0);
  assert.ok(r.decision.reason_codes.includes("price_above_declared"));
});

test("V7 WARN 免除＋床＋verified_terms 一致 → paid", async () => {
  const signed = [];
  const acc = { ...account, signTypedData: async () => (signed.push(1), "0x" + "00".repeat(65)) };
  const fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/decision")) {
      return new Response(JSON.stringify(warnDecisionBody(TERMS)), { status: 200 });
    }
    return stubFetch(TERMS, GOOD, "10000")(input, init);
  };
  const r = await payOrRefuse({
    payee: GOOD,
    resource: RESOURCE,
    amountUsd: 0.01,
    account: acc,
    fetch,
    policy: waivePolicy,
  });
  assert.equal(r.status, "paid");
  assert.equal(signed.length, 1);
});

test("V5 skipVerifiedTermsCheck で照合を外せる", async () => {
  const signed = [];
  const acc = { ...account, signTypedData: async () => (signed.push(1), "0x" + "00".repeat(65)) };
  const r = await payOrRefuse({
    payee: EVIL,
    resource: RESOURCE,
    amountUsd: 1,
    account: acc,
    fetch: stubFetch(TERMS, EVIL, "1000000"),
    policy: { skipVerifiedTermsCheck: true },
  });
  assert.notEqual(r.status, "refused");
});