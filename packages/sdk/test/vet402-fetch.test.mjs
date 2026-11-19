// createVet402Fetch: fake seller and fake vet402 only. No network, no money.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  pay,
  createVet402Fetch,
  Vet402RefusedError,
  Vet402PayFailedError,
} from "../dist/index.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const URL_A = "https://seller.example/v1/search";
const API = "https://vet402.com/api/v1";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

const offer = (over = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});
const challenge = (accepts) =>
  new Response("{}", {
    status: 402,
    headers: { "payment-required": b64({ x402Version: 2, resource: { url: URL_A }, accepts }) },
  });
const verdict = (recommendation, over = {}) => ({
  subject: { type: "resource", id: "a".repeat(64) },
  role: "payer",
  recommendation,
  reason_codes: ["l0_pass"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [],
  degraded: false,
  policy: "allow_only",
  rules_version: "test",
  ...over,
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness({ decision = () => json(200, verdict("ALLOW")), offers = () => [offer()], score = () => json(200, {}) } = {}) {
  const seen = { seller: [], decisions: [], scores: 0, signatures: 0 };
  const account = {
    address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
    signTypedData: async () => {
      seen.signatures += 1;
      return `0x${"ab".repeat(65)}`;
    },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) {
      seen.decisions.push(url);
      return decision(url);
    }
    if (url.startsWith(`${API}/payees/`)) {
      seen.scores += 1;
      return score(url);
    }
    if (url.startsWith(`${API}/`)) return json(200, {});
    assert.equal(url, URL_A);
    const headers = new Headers(init.headers);
    seen.seller.push({
      method: init.method,
      body: init.body,
      auth: headers.get("authorization"),
      paid: headers.has("payment-signature"),
    });
    if (headers.has("payment-signature")) {
      return new Response('{"answer":42}', {
        status: 200,
        headers: {
          "payment-response": b64({
            success: true,
            transaction: `0x${"cd".repeat(32)}`,
            network: "eip155:8453",
            payer: account.address,
          }),
        },
      });
    }
    return challenge(offers(seen.seller.length));
  };
  const payOptions = { account, fetch: fetchImpl };
  const vet402Fetch = createVet402Fetch(payOptions);
  return { seen, account, fetchImpl, payOptions, vet402Fetch };
}

function payResultSnapshot(result) {
  return {
    status: result.status,
    recommendation: result.recommendation,
    reasonCodes: [...result.reasonCodes],
    signed: result.signed,
    txHash: result.txHash,
    receipt: result.receipt,
  };
}

async function assertSameAsPay(payOptions, url, init, fetchFn, input, init2) {
  const direct = await pay(url, init, payOptions);
  let thrown = null;
  let response = null;
  try {
    response = await fetchFn(input, init2);
  } catch (err) {
    thrown = err;
  }
  if (direct.status === "paid" || direct.status === "no_payment_required") {
    assert.equal(thrown, null);
    assert.equal(response.status, direct.response.status);
    assert.equal(await response.text(), await direct.response.text());
    return;
  }
  assert.ok(thrown instanceof Vet402RefusedError || thrown instanceof Vet402PayFailedError);
  assert.equal(thrown.result.status, direct.status);
  assert.deepEqual(payResultSnapshot(thrown.result), payResultSnapshot(direct));
}

test("a seller that answers without a 402 returns the response unchanged", async () => {
  const account = { address: PAY_TO, signTypedData: async () => assert.fail("must not sign") };
  const fetchImpl = async () => new Response("free", { status: 200 });
  const vet402Fetch = createVet402Fetch({ account, fetch: fetchImpl });
  const response = await vet402Fetch(URL_A);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "free");
});

test("ALLOW pays once through the fetch shape", async () => {
  const h = harness();
  const response = await h.vet402Fetch(URL_A);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer: 42 });
  assert.equal(h.seen.signatures, 1);
});

test("POST via init.method delivers the body on every seller call", async () => {
  const h = harness();
  const init = { method: "post", headers: { authorization: "Bearer seller" }, body: '{"q":"x"}' };
  await h.vet402Fetch(URL_A, init);
  const id = createHash("sha256").update(`POST ${URL_A}`).digest("hex");
  assert.ok(h.seen.decisions[0].includes(`/resources/${id}/decision`));
  assert.ok(h.seen.seller.length >= 3);
  for (const call of h.seen.seller) {
    assert.equal(call.method, "POST");
    assert.equal(call.body, '{"q":"x"}');
    assert.equal(call.auth, "Bearer seller");
  }
});

test("POST via Request delivers the body on every seller call", async () => {
  const h = harness();
  const req = new Request(URL_A, { method: "POST", headers: { authorization: "Bearer seller" }, body: '{"q":"x"}' });
  await h.vet402Fetch(req);
  for (const call of h.seen.seller) {
    assert.equal(call.method, "POST");
    assert.equal(call.body, '{"q":"x"}');
    assert.equal(call.auth, "Bearer seller");
  }
});

test("BLOCK refuses with no signature and carries PayResult on the error", async () => {
  const h = harness({ decision: () => json(200, verdict("BLOCK")) });
  await assert.rejects(h.vet402Fetch(URL_A), (err) => {
    assert.ok(err instanceof Vet402RefusedError);
    assert.equal(err.result.status, "refused");
    assert.match(err.result.reasonCodes.join(","), /payee_recommendation_block/);
    assert.equal(err.result.signed, false);
    return true;
  });
  assert.equal(h.seen.signatures, 0);
});

test("a price above maxUsd matches pay() and signs nothing", async () => {
  const h = harness({ offers: () => [offer({ amount: "2000000" })] });
  await assertSameAsPay(h.payOptions, URL_A, undefined, h.vet402Fetch, URL_A);
  assert.equal(h.seen.signatures, 0);
});

test("a vet402 read failure matches pay() and signs nothing", async () => {
  const h = harness({ decision: () => json(500, {}) });
  await assertSameAsPay(h.payOptions, URL_A, undefined, h.vet402Fetch, URL_A);
  assert.equal(h.seen.signatures, 0);
});

test("a seller redirect matches pay() and signs nothing", async () => {
  const inner = harness();
  const fetchImpl = async (input, init = {}) => {
    if (String(input) === URL_A && init.redirect === "error") throw new TypeError("unexpected redirect");
    return inner.fetchImpl(input, init);
  };
  const payOptions = { account: inner.account, fetch: fetchImpl };
  const vet402Fetch = createVet402Fetch(payOptions);
  await assertSameAsPay(payOptions, URL_A, undefined, vet402Fetch, URL_A);
  assert.equal(inner.seen.signatures, 0);
});

test("http:// throws before any signature, same as pay()", async () => {
  const h = harness();
  const fetchImpl = async () => assert.fail("must not fetch");
  const payOptions = { account: h.account, fetch: fetchImpl };
  const vet402Fetch = createVet402Fetch(payOptions);
  await assert.rejects(pay("http://seller.example/x", undefined, payOptions), /invalid_url/);
  await assert.rejects(vet402Fetch("http://seller.example/x"), /invalid_url/);
});

test("failed status throws Vet402PayFailedError and never returns the response", async () => {
  const h = harness();
  const paidNoTx = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/`)) return h.fetchImpl(input, init);
    const headers = new Headers(init.headers);
    if (headers.has("payment-signature")) {
      return new Response("ok", {
        status: 200,
        headers: {
          "payment-response": b64({ success: true, network: "eip155:8453", payer: h.account.address }),
        },
      });
    }
    return challenge([offer()]);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: paidNoTx });
  await assert.rejects(vet402Fetch(URL_A), (err) => {
    assert.ok(err instanceof Vet402PayFailedError);
    assert.equal(err.result.status, "failed");
    assert.equal(err.result.signed, true);
    return true;
  });
});