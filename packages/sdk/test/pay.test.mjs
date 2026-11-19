// pay(): every case runs against a fake seller and a fake vet402. No network, no money.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pay } from "../dist/index.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const OTHER = "0x1111111111111111111111111111111111111111";
const URL_A = "https://seller.example/v1/search";
const API = "https://vet402.com/api/v1";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

const offer = (over = {}) => ({
  scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" }, ...over,
});
const challenge = (accepts) => new Response("{}", {
  status: 402,
  headers: { "payment-required": b64({ x402Version: 2, resource: { url: URL_A }, accepts }) },
});
const verdict = (recommendation, over = {}) => ({
  subject: { type: "resource", id: "a".repeat(64) }, role: "payer", recommendation, reason_codes: ["l0_pass"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [], degraded: false, policy: "allow_only", rules_version: "test", ...over,
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness({ decision = () => json(200, verdict("ALLOW")), offers = () => [offer()], score = () => json(200, {}) } = {}) {
  const seen = { seller: [], decisions: [], scores: 0, signatures: 0 };
  const account = {
    address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
    signTypedData: async () => { seen.signatures += 1; return `0x${"ab".repeat(65)}`; },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) { seen.decisions.push(url); return decision(url); }
    if (url.startsWith(`${API}/payees/`)) { seen.scores += 1; return score(url); }
    if (url.startsWith(`${API}/`)) return json(200, {});
    assert.equal(url, URL_A);
    const headers = new Headers(init.headers);
    seen.seller.push({
      method: init.method,
      body: init.body,
      auth: headers.get("authorization"),
      paid: headers.has("payment-signature"),
      contentType: headers.get("content-type"),
    });
    if (headers.has("payment-signature")) {
      return new Response('{"answer":42}', {
        status: 200,
        headers: { "payment-response": b64({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453", payer: account.address }) },
      });
    }
    return challenge(offers(seen.seller.length));
  };
  return { seen, account, fetchImpl };
}

test("ALLOW pays once and returns the seller's answer", async () => {
  const h = harness();
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "paid");
  assert.equal(r.recommendation, "ALLOW");
  assert.equal(h.seen.signatures, 1);
  assert.deepEqual(await r.response.json(), { answer: 42 });
});

test("POST reads the POST verdict and sends the body on every seller request", async () => {
  const h = harness();
  const init = { method: "post", headers: { authorization: "Bearer seller" }, body: '{"q":"x"}' };
  const r = await pay(URL_A, init, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "paid");
  const id = createHash("sha256").update(`POST ${URL_A}`).digest("hex");
  assert.ok(h.seen.decisions[0].includes(`/resources/${id}/decision`));
  assert.ok(h.seen.seller.length >= 3);
  for (const call of h.seen.seller) {
    assert.equal(call.method, "POST");
    assert.equal(call.body, '{"q":"x"}');
    assert.equal(call.auth, "Bearer seller");
  }
});

for (const [name, decision, reason] of [
  ["BLOCK", () => json(200, verdict("BLOCK")), /payee_recommendation_block/],
  ["WARN by default", () => json(200, verdict("WARN")), /payee_recommendation_not_allow/],
  ["an unknown verdict word", () => json(200, verdict("MAYBE")), /not_allow|evidence_unavailable/],
  ["a verdict with no word", () => json(200, { reason_codes: [] }), /not_allow|evidence_unavailable/],
  ["a body that is not JSON", () => new Response("<html>", { status: 200 }), /evidence_unavailable/],
  ["vet402 answering 500", () => json(500, {}), /evidence_unavailable/],
  ["vet402 answering 429", () => json(429, {}), /evidence_unavailable/],
  ["vet402 unreachable", () => { throw new Error("down"); }, /evidence_unavailable/],
  ["a degraded verdict", () => json(200, verdict("ALLOW", { degraded: true })), /evidence_unavailable/],
]) {
  test(`${name}: refused with no signature`, async () => {
    const h = harness({ decision });
    const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
    assert.equal(r.status, "refused");
    assert.equal(r.signed, false);
    assert.equal(h.seen.signatures, 0);
    assert.match(r.reasonCodes.join(","), reason);
  });
}

test("a URL with no record is refused by default and the payee score is never read", async () => {
  const h = harness({ decision: () => json(404, { error: "not_found" }) });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.scores, 0);
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /resource_uncatalogued/);
});

test("allowUnknown only opens the payee score path, and a failed score still refuses", async () => {
  const h = harness({ decision: () => json(404, { error: "not_found" }), score: () => json(500, {}) });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl, allowUnknown: true });
  assert.equal(h.seen.scores, 1);
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("allowUnknown pays only when the payee score says ALLOW", async () => {
  const score = (recommendation) => () => json(200, { address: PAY_TO, score: 74, recommendation, dataDepth: "moderate", degraded: false, signalsUnavailable: [] });
  const none = () => json(404, { error: "not_found" });

  const allowed = harness({ decision: none, score: score("ALLOW") });
  const paid = await pay(URL_A, undefined, { account: allowed.account, fetch: allowed.fetchImpl, allowUnknown: true });
  assert.equal(paid.status, "paid");
  assert.equal(allowed.seen.signatures, 1);

  for (const word of ["WARN", "BLOCK"]) {
    const h = harness({ decision: none, score: score(word) });
    const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl, allowUnknown: true });
    assert.equal(r.status, "refused");
    assert.equal(h.seen.signatures, 0);
  }
});

test("allowWarn pays WARN only when vet402 recorded a delivery", async () => {
  const delivered = harness({ decision: () => json(200, verdict("WARN")) });
  const paid = await pay(URL_A, undefined, { account: delivered.account, fetch: delivered.fetchImpl, allowWarn: true });
  assert.equal(paid.status, "paid");
  assert.equal(delivered.seen.signatures, 1);

  const none = harness({ decision: () => json(200, verdict("WARN", { facts: { l0: { status: "pass" }, l1: { n_delivered: 0, n_attempts: 1 }, l2: { status: "undeclared" } } })) });
  const stopped = await pay(URL_A, undefined, { account: none.account, fetch: none.fetchImpl, allowWarn: true });
  assert.equal(stopped.status, "refused");
  assert.equal(none.seen.signatures, 0);
});

test("allowWarn never pays BLOCK", async () => {
  const h = harness({ decision: () => json(200, verdict("BLOCK")) });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl, allowWarn: true, allowUnknown: true });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("a price above maxUsd is refused before vet402 is read", async () => {
  const h = harness({ offers: () => [offer({ amount: "2000000" })] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.deepEqual(r.reasonCodes, ["price_above_ceiling"]);
  assert.equal(h.seen.decisions.length, 0);
  assert.equal(h.seen.signatures, 0);
});

test("a seller that changes payTo after the first 402 is refused", async () => {
  const h = harness({ offers: (n) => [offer(n === 1 ? {} : { payTo: OTHER })] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /payee_mismatch/);
});

test("a seller that raises the price after the first 402 is refused", async () => {
  const h = harness({ offers: (n) => [offer(n === 1 ? {} : { amount: "20000" })] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /price_above_declared/);
});

for (const [name, offers] of [
  ["another asset", [offer({ asset: OTHER })]],
  ["another chain", [offer({ network: "eip155:1" })]],
  ["another scheme", [offer({ scheme: "upto" })]],
  ["a zero price", [offer({ amount: "0" })]],
  ["a price that is not a whole number", [offer({ amount: "1.5" })]],
  ["a bad payTo", [offer({ payTo: "nobody" })]],
  ["no offers", []],
]) {
  test(`a 402 with ${name} is refused with no signature`, async () => {
    const h = harness({ offers: () => offers });
    const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
    assert.deepEqual(r.reasonCodes, ["no_eligible_accept"]);
    assert.equal(h.seen.signatures, 0);
  });
}

test("an unpayable first offer is skipped and the payable one is paid", async () => {
  const h = harness({ offers: () => [offer({ asset: OTHER, payTo: OTHER }), offer()] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "paid");
  assert.equal(h.seen.signatures, 1);
});

test("an offer with another transfer method is not payable", async () => {
  const h = harness({ offers: () => [offer({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } })] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.deepEqual(r.reasonCodes, ["no_eligible_accept"]);
  assert.equal(h.seen.signatures, 0);
});

test("when payOrRefuse would choose a different offer, nothing is signed", async () => {
  const noncanonical = offer({ extra: { name: "Not USDC", version: "9" } });
  const canonical = offer({ payTo: OTHER });
  const h = harness({ offers: () => [noncanonical, canonical] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /payee_mismatch/);
});

test("two offers to one payee never sign more than the price pay read", async () => {
  const noncanonical = offer({ amount: "10000", extra: { name: "Not USDC", version: "9" } });
  const canonical = offer({ amount: "20000" });
  const h = harness({ offers: () => [noncanonical, canonical] });
  const r = await pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /price_above_declared/);
});

test("every seller request refuses redirects, whatever the caller passes", async () => {
  const modes = [];
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    if (String(input) === URL_A) modes.push(init.redirect);
    return h.fetchImpl(input, init);
  };
  const r = await pay(URL_A, { redirect: "follow" }, { account: h.account, fetch: fetchImpl });
  assert.equal(r.status, "paid");
  assert.ok(modes.length >= 3);
  assert.ok(modes.every((mode) => mode === "error"));
});

test("a seller that redirects is refused with no signature", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    if (String(input) === URL_A && init.redirect === "error") throw new TypeError("unexpected redirect");
    return h.fetchImpl(input, init);
  };
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl });
  assert.deepEqual(r.reasonCodes, ["seller_unreachable"]);
  assert.equal(h.seen.signatures, 0);
});

test("a seller that answers without a 402 is returned unpaid", async () => {
  const account = { address: OTHER, signTypedData: async () => assert.fail("must not sign") };
  const r = await pay(URL_A, undefined, { account, fetch: async () => new Response("free", { status: 200 }) });
  assert.equal(r.status, "no_payment_required");
  assert.equal(await r.response.text(), "free");
});

test("a failing seller is refused with no signature", async () => {
  const account = { address: OTHER, signTypedData: async () => assert.fail("must not sign") };
  const r = await pay(URL_A, undefined, { account, fetch: async () => new Response("no", { status: 500 }) });
  assert.deepEqual(r.reasonCodes, ["no_payment_request"]);
});

test("caller errors throw before any request", async () => {
  const account = { address: OTHER, signTypedData: async () => assert.fail("must not sign") };
  const fetchImpl = async () => assert.fail("must not fetch");
  await assert.rejects(pay(new Request(URL_A), undefined, { account, fetch: fetchImpl }), /invalid_url/);
  await assert.rejects(pay("http://seller.example/x", undefined, { account, fetch: fetchImpl }), /invalid_url/);
  await assert.rejects(pay(URL_A, undefined, { fetch: fetchImpl }), /invalid_payer/);
  for (const maxUsd of [Number.NaN, Infinity, 0, -1, "1"]) {
    await assert.rejects(pay(URL_A, undefined, { account, fetch: fetchImpl, maxUsd }), /invalid_max_usd/);
  }
  await assert.rejects(pay(URL_A, undefined, { account, fetch: fetchImpl, network: "constructor" }), /invalid_network/);
  await assert.rejects(pay(URL_A, { method: "POST", body: new ReadableStream() }, { account, fetch: fetchImpl }), /invalid_body/);
});

test("attest POST after payment does not use the caller abort signal", async () => {
  const h = harness();
  const attestInit = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === `${API}/payments/x402` && init.method === "POST") {
      attestInit.push(init);
      return json(200, { ok: true });
    }
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    return h.fetchImpl(input, init);
  };
  const controller = new AbortController();
  const work = pay(URL_A, { signal: controller.signal }, { account: h.account, fetch: fetchImpl });
  for (let i = 0; i < 200 && h.seen.signatures < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  const r = await work;
  assert.equal(r.status, "paid");
  assert.equal(attestInit.length, 1);
  assert.notEqual(attestInit[0].signal, controller.signal);
  assert.equal(attestInit[0].signal?.aborted ?? false, false);
});

test("paid seller body is not cut by requestTimeoutMs", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/`)) return h.fetchImpl(input, init);
    const headers = new Headers(init.headers);
    if (headers.has("payment-signature")) {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("part1-"));
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(new TextEncoder().encode("part2-end"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "payment-response": b64({
            success: true,
            transaction: `0x${"cd".repeat(32)}`,
            network: "eip155:8453",
            payer: h.account.address,
          }),
        },
      });
    }
    return h.fetchImpl(input, init);
  };
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl, requestTimeoutMs: 30 });
  assert.equal(r.status, "paid");
  assert.equal(await r.response.text(), "part1-part2-end");
});

test("paid seller slow headers still returns paid with body and txHash", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/`)) return h.fetchImpl(input, init);
    const headers = new Headers(init.headers);
    if (headers.has("payment-signature")) {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response("late-body", {
                status: 200,
                headers: {
                  "payment-response": b64({
                    success: true,
                    transaction: `0x${"cd".repeat(32)}`,
                    network: "eip155:8453",
                    payer: h.account.address,
                  }),
                },
              }),
            ),
          200,
        ),
      );
    }
    return h.fetchImpl(input, init);
  };
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl, requestTimeoutMs: 50 });
  assert.equal(r.status, "paid");
  assert.equal(r.signed, true);
  assert.ok(r.txHash);
  assert.equal(await r.response.text(), "late-body");
});

test("no_payment_required slow body completes despite short requestTimeoutMs", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/`)) return h.fetchImpl(input, init);
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("free-"));
        await new Promise((r) => setTimeout(r, 80));
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
  };
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl, requestTimeoutMs: 30 });
  assert.equal(r.status, "no_payment_required");
  assert.equal(await r.response.text(), "free-body");
  assert.equal(h.seen.signatures, 0);
});

test("attest stall with signal-ignoring fetch returns paid within requestTimeoutMs", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === `${API}/payments/x402` && (init.method ?? "GET").toUpperCase() === "POST") {
      return new Promise(() => {});
    }
    const { signal: _drop, ...rest } = init;
    return h.fetchImpl(input, rest);
  };
  const started = Date.now();
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl, requestTimeoutMs: 80 });
  assert.equal(r.status, "paid");
  assert.equal(r.signed, true);
  assert.ok(r.txHash);
  assert.ok(Date.now() - started < 2000);
});

test("invalid requestTimeoutMs throws before the seller is called", async () => {
  const h = harness();
  for (const v of [-1, NaN, Infinity, "50"]) {
    await assert.rejects(pay(URL_A, undefined, { account: h.account, fetch: h.fetchImpl, requestTimeoutMs: v }), /invalid_request_timeout_ms/);
  }
  assert.equal(h.seen.seller.length, 0);
  assert.equal(h.seen.signatures, 0);
});

test("vet402 decision body stall stops at requestTimeoutMs without signing", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    return h.fetchImpl(input, init);
  };
  const started = Date.now();
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl, requestTimeoutMs: 50 });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.ok(Date.now() - started < 400);
});

test("vet402 decision body stall with signal-ignoring fetch stops at requestTimeoutMs", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    return h.fetchImpl(input, init);
  };
  const started = Date.now();
  const r = await pay(URL_A, undefined, { account: h.account, fetch: fetchImpl, requestTimeoutMs: 50 });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.ok(Date.now() - started < 400);
});

test("URLSearchParams form Content-Type is kept on the paid seller call", async () => {
  const h = harness();
  const body = new URLSearchParams({ q: "x", y: "z" });
  const r = await pay(URL_A, { method: "POST", body }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "paid");
  const unpaid = h.seen.seller.find((c) => !c.paid);
  const paid = h.seen.seller.find((c) => c.paid);
  assert.notEqual(paid.contentType, "application/json");
  assert.equal(paid.contentType, unpaid.contentType);
  const wireCt = new Request(URL_A, { method: "POST", body }).headers.get("content-type");
  if (unpaid.contentType !== null) assert.equal(unpaid.contentType, wireCt);
  if (paid.contentType !== null) assert.equal(paid.contentType, wireCt);
});
