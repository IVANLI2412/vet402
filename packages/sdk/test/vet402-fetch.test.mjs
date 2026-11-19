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
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
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
      contentType: headers.get("content-type"),
      accept: headers.get("accept"),
      xPayment: headers.get("x-payment"),
      paymentSignature: headers.get("payment-signature"),
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
    const bytes = await sellerBodyBytes(call.body);
    assert.deepEqual([...bytes], [...new TextEncoder().encode('{"q":"x"}')]);
    assert.equal(call.auth, "Bearer seller");
  }
});

test("POST via Request delivers the body on every seller call", async () => {
  const h = harness();
  const req = new Request(URL_A, { method: "POST", headers: { authorization: "Bearer seller" }, body: '{"q":"x"}' });
  await h.vet402Fetch(req);
  for (const call of h.seen.seller) {
    assert.equal(call.method, "POST");
    const bodyText = typeof call.body === "string" ? call.body : new TextDecoder().decode(call.body);
    assert.equal(bodyText, '{"q":"x"}');
    assert.equal(call.auth, "Bearer seller");
  }
});

test("POST via Request delivers binary body bytes on every seller call", async () => {
  const h = harness();
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]);
  const req = new Request(URL_A, { method: "POST", headers: { authorization: "Bearer seller" }, body: bytes });
  await h.vet402Fetch(req);
  const expected = [0xff, 0xfe, 0x00, 0x80, 0x41];
  for (const call of h.seen.seller) {
    assert.equal(call.method, "POST");
    assert.ok(call.body instanceof Uint8Array);
    assert.deepEqual([...call.body], expected);
    assert.equal(call.auth, "Bearer seller");
  }
});

test("an already-aborted GET on init rejects with signal.reason before pay()", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort(new DOMException("pre-abort", "AbortError"));
  await assert.rejects(h.vet402Fetch(URL_A, { signal: controller.signal }), (err) => err === controller.signal.reason);
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller.length, 0);
  assert.equal(h.seen.decisions.length, 0);
});

test("an already-aborted GET on Request rejects with signal.reason before pay()", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort(new DOMException("pre-abort", "AbortError"));
  const req = new Request(URL_A, { signal: controller.signal });
  await assert.rejects(h.vet402Fetch(req), (err) => err === controller.signal.reason);
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller.length, 0);
  assert.equal(h.seen.decisions.length, 0);
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

async function sellerBodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  assert.fail(`unexpected body type ${body?.constructor?.name}`);
}

const contentTypeCases = [
  ["FormData", () => {
    const fd = new FormData();
    fd.append("q", "x");
    fd.append("f", new Blob(["bin"], { type: "application/octet-stream" }));
    return { body: fd, expectCt: /multipart\/form-data/ };
  }],
  ["URLSearchParams", () => ({ body: new URLSearchParams({ q: "x" }), expectCt: "application/x-www-form-urlencoded;charset=UTF-8" })],
  ["Blob", () => {
    const body = new Blob(['{"q":"x"}'], { type: "text/csv" });
    return { body, expectCt: "text/csv" };
  }],
  ["text/csv string", () => ({ body: "a,b\n1,2", headers: { "content-type": "text/csv" }, expectCt: "text/csv" })],
];

for (const [name, make] of contentTypeCases) {
  test(`paid seller call keeps caller Content-Type for ${name}`, async () => {
    const { body, headers = {}, expectCt } = make();
    const h = harness();
    const init = { method: "POST", headers, body };
    await h.vet402Fetch(URL_A, init);
    const unpaid = h.seen.seller.find((c) => !c.paid);
    const paid = h.seen.seller.find((c) => c.paid);
    assert.ok(unpaid);
    assert.ok(paid);
    if (typeof expectCt === "string") {
      assert.equal(unpaid.contentType, expectCt);
      assert.equal(paid.contentType, expectCt);
    } else {
      assert.match(unpaid.contentType, expectCt);
      assert.match(paid.contentType, expectCt);
    }
    assert.equal(unpaid.accept, paid.accept);
  });
}

test("vet402 decision that never answers aborts within 100ms and never signs", async () => {
  const h = harness({
    decision: () => new Promise(() => {}),
  });
  const fetchImpl = async (input, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return h.fetchImpl(input, init);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const controller = new AbortController();
  const init = { signal: controller.signal };
  const started = Date.now();
  const work = vet402Fetch(URL_A, init).catch((err) => err);
  setTimeout(() => controller.abort(), 5);
  const err = await work;
  assert.ok(err?.name === "AbortError" || err === controller.signal.reason);
  assert.ok(Date.now() - started < 100);
  assert.equal(h.seen.signatures, 0);
});

test("abort after payment records ledger once and rejects with paid vet402PayResult", async () => {
  let attests = 0;
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === `${API}/payments/x402` && init.method === "POST") {
      attests += 1;
      return new Promise((resolve) => setTimeout(() => resolve(json(200, { ok: true })), 30));
    }
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    return h.fetchImpl(input, init);
  };
  const controller = new AbortController();
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const work = vet402Fetch(URL_A, { signal: controller.signal }).catch((err) => err);
  for (let i = 0; i < 200 && h.seen.signatures < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.seen.signatures, 1);
  controller.abort();
  const err = await Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
  ]);
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.equal(err.vet402PayResult.status, "paid");
  assert.ok(err.vet402PayResult.txHash);
  assert.equal(attests, 1);
});

test("a never-ending Request body stream aborts before seller or signer", async () => {
  const account = { address: PAY_TO, signTypedData: async () => assert.fail("must not sign") };
  let sellerCalls = 0;
  const fetchImpl = async () => {
    sellerCalls += 1;
    assert.fail("must not reach seller");
  };
  const vet402Fetch = createVet402Fetch({ account, fetch: fetchImpl });
  const controller = new AbortController();
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
  const work = vet402Fetch(URL_A, {
    method: "POST",
    body: stream,
    signal: controller.signal,
    duplex: "half",
  }).catch((err) => err);
  setTimeout(() => controller.abort(), 5);
  const err = await work;
  assert.equal(sellerCalls, 0);
  assert.ok(err?.name === "AbortError" || err === controller.signal.reason);
});

test("request body larger than 10 MiB throws invalid_body before the seller", async () => {
  const h = harness();
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: h.fetchImpl });
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  await assert.rejects(vet402Fetch(URL_A, { method: "POST", body: big }), /invalid_body: request body is larger than 10 MiB/);
  assert.equal(h.seen.seller.length, 0);
});

test("caller x-payment is not sent to a BLOCK seller", async () => {
  const h = harness({ decision: () => json(200, verdict("BLOCK")) });
  await assert.rejects(
    h.vet402Fetch(URL_A, { headers: { "x-payment": "forged" } }),
    (err) => err instanceof Vet402RefusedError,
  );
  for (const call of h.seen.seller) assert.equal(call.xPayment, null);
  assert.equal(h.seen.signatures, 0);
});

test("init headers and body override Request values on every seller call", async () => {
  const h = harness();
  const req = new Request(URL_A, { method: "POST", headers: { authorization: "from-request" }, body: "from-request" });
  const init = { method: "POST", headers: { authorization: "from-init" }, body: "from-init" };
  await h.vet402Fetch(req, init);
  for (const call of h.seen.seller) {
    assert.equal(call.auth, "from-init");
    const expected = typeof call.body === "string" ? call.body : new TextDecoder().decode(call.body);
    assert.equal(expected, "from-init");
  }
});

test("four fetch entry points deliver the same FormData bytes", async () => {
  const fd = new FormData();
  fd.append("q", "same");
  fd.append("f", new Blob(["xy"], { type: "application/octet-stream" }));
  const seed = new Request(URL_A, { method: "POST", body: fd });
  const golden = new Uint8Array(await seed.arrayBuffer());
  const goldenHeaders = { "content-type": seed.headers.get("content-type") };
  const entries = [
    ["string", (h) => h.vet402Fetch(URL_A, { method: "POST", headers: goldenHeaders, body: golden })],
    ["url", (h) => h.vet402Fetch(new URL(URL_A), { method: "POST", headers: goldenHeaders, body: golden })],
    ["request", (h) => h.vet402Fetch(new Request(URL_A, { method: "POST", headers: goldenHeaders, body: golden }))],
    [
      "request+init",
      (h) =>
        h.vet402Fetch(new Request(URL_A, { method: "POST", body: "ignored" }), {
          method: "POST",
          headers: goldenHeaders,
          body: golden,
        }),
    ],
  ];
  for (const [label, run] of entries) {
    const h = harness();
    await run(h);
    for (const call of h.seen.seller) {
      const bytes = await sellerBodyBytes(call.body);
      assert.deepEqual([...bytes], [...golden], label);
    }
  }
});

for (const [name, decision, reason] of [
  ["WARN by default", () => json(200, verdict("WARN")), /payee_recommendation_not_allow/],
  ["an unknown verdict word", () => json(200, verdict("MAYBE")), /not_allow|evidence_unavailable/],
]) {
  test(`vet402Fetch ${name} matches pay()`, async () => {
    const h = harness({ decision });
    await assertSameAsPay(h.payOptions, URL_A, undefined, h.vet402Fetch, URL_A);
    assert.equal(h.seen.signatures, 0);
    const direct = await pay(URL_A, undefined, h.payOptions);
    assert.match(direct.reasonCodes.join(","), reason);
  });
}

test("already-aborted POST with a body rejects with signal.reason before pay()", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort(new DOMException("pre-abort", "AbortError"));
  await assert.rejects(
    h.vet402Fetch(URL_A, { method: "POST", body: "payload", signal: controller.signal }),
    (err) => err === controller.signal.reason,
  );
  assert.equal(h.seen.seller.length, 0);
  assert.equal(h.seen.signatures, 0);
});

test("vet402 /decision that ignores signal aborts with caller signal within 500ms", async () => {
  const h = harness({
    decision: () => new Promise(() => {}),
  });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) return new Promise(() => {});
    return h.fetchImpl(input, init);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const controller = new AbortController();
  const started = Date.now();
  const work = vet402Fetch(URL_A, { signal: controller.signal }).catch((err) => err);
  setTimeout(() => controller.abort(), 50);
  const err = await Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
  ]);
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.equal(err.vet402PayResult.status, "refused");
  assert.ok(err.vet402PayResult.reasonCodes.includes("aborted"));
  assert.ok(Date.now() - started < 500);
  assert.equal(h.seen.signatures, 0);
});

test("vet402 /decision that never answers refuses within requestTimeoutMs without a caller signal", async () => {
  const h = harness({
    decision: () => new Promise(() => {}),
  });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/resources/`)) return new Promise(() => {});
    return h.fetchImpl(input, init);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl, requestTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(vet402Fetch(URL_A), (err) => {
    assert.ok(err instanceof Vet402RefusedError);
    return true;
  });
  assert.ok(Date.now() - started < 200);
  assert.equal(h.seen.signatures, 0);
});

test("paid seller fetch that ignores signal still completes and rejects with paid vet402PayResult after abort", async () => {
  let attests = 0;
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === `${API}/payments/x402` && init.method === "POST") {
      attests += 1;
      return json(200, { ok: true });
    }
    if (url === URL_A) {
      const headers = new Headers(init.headers);
      if (headers.has("payment-signature")) {
        return new Promise((resolve) => setTimeout(() => resolve(new Response('{"answer":42}', {
          status: 200,
          headers: {
            "payment-response": b64({
              success: true,
              transaction: `0x${"cd".repeat(32)}`,
              network: "eip155:8453",
              payer: h.account.address,
            }),
          },
        })), 80));
      }
    }
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    return h.fetchImpl(input, init);
  };
  const controller = new AbortController();
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const work = vet402Fetch(URL_A, { signal: controller.signal }).catch((err) => err);
  for (let i = 0; i < 200 && h.seen.signatures < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.seen.signatures, 1);
  controller.abort();
  const err = await Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
  ]);
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.equal(err.vet402PayResult.status, "paid");
  assert.ok(err.vet402PayResult.txHash);
  assert.equal(attests, 1);
});

test("four entry points deliver invalid UTF-8 bytes with no Content-Type on every seller call", async () => {
  const golden = new Uint8Array([0xff, 0x41]);
  const entries = [
    ["string", (h) => h.vet402Fetch(URL_A, { method: "POST", body: golden })],
    ["url", (h) => h.vet402Fetch(new URL(URL_A), { method: "POST", body: golden })],
    ["request", (h) => h.vet402Fetch(new Request(URL_A, { method: "POST", body: golden }))],
    [
      "request+init",
      (h) =>
        h.vet402Fetch(new Request(URL_A, { method: "POST", body: new Uint8Array([0x00]) }), {
          method: "POST",
          body: golden,
        }),
    ],
  ];
  for (const [label, run] of entries) {
    const h = harness();
    await run(h);
    assert.ok(h.seen.seller.length >= 2, label);
    for (const call of h.seen.seller) {
      const bytes = await sellerBodyBytes(call.body);
      assert.deepEqual([...bytes], [...golden], label);
      assert.equal(call.contentType, null, label);
    }
  }
});

test("BOM-prefixed JSON bytes and application/json reach the seller unchanged", async () => {
  const golden = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  const headers = { "content-type": "application/json" };
  const h = harness();
  await h.vet402Fetch(URL_A, { method: "POST", headers, body: golden });
  for (const call of h.seen.seller) {
    const bytes = await sellerBodyBytes(call.body);
    assert.deepEqual([...bytes], [...golden]);
    assert.equal(call.contentType, "application/json");
  }
});

test("Blob without type and ArrayBuffer match on every seller call", async () => {
  const raw = new Uint8Array([0xff, 0x41]);
  for (const [label, body] of [
    ["Blob", new Blob([raw])],
    ["ArrayBuffer", raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)],
  ]) {
    const h = harness();
    await h.vet402Fetch(URL_A, { method: "POST", body });
    for (const call of h.seen.seller) {
      const bytes = await sellerBodyBytes(call.body);
      assert.deepEqual([...bytes], [...raw], label);
      assert.equal(call.contentType, null, label);
    }
  }
});

test("abort during the first seller round-trip rejects as AbortError, not seller_unreachable", async () => {
  const h = harness();
  const fetchImpl = async (input, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    const url = String(input);
    if (url.startsWith(`${API}/`)) return h.fetchImpl(input, init);
    assert.equal(url, URL_A);
    return new Promise((_, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      );
    });
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const controller = new AbortController();
  const work = vet402Fetch(URL_A, { signal: controller.signal }).catch((err) => err);
  setTimeout(() => controller.abort(), 10);
  const err = await work;
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.equal(err.vet402PayResult.reasonCodes[0], "seller_unreachable");
  assert.ok(err.vet402PayResult.reasonCodes.includes("aborted"));
  assert.equal(h.seen.signatures, 0);
});

test("POST with an empty body sends an empty byte sequence to the seller", async () => {
  const h = harness();
  await h.vet402Fetch(URL_A, { method: "POST", body: "" });
  for (const call of h.seen.seller) {
    assert.equal(call.method, "POST");
    assert.ok(call.body instanceof Uint8Array);
    assert.equal(call.body.byteLength, 0);
  }
});

test("abort during a slow vet402 decision and GC before pay never signs (four entry points)", async () => {
  const slowDecision = () => new Promise((resolve) => setTimeout(() => resolve(json(200, verdict("ALLOW"))), 200));
  const entries = [
    ["string", (vf, signal) => vf(URL_A, { signal })],
    ["url", (vf, signal) => vf(new URL(URL_A), { signal })],
    ["request", (vf, signal) => vf(new Request(URL_A, { signal }))],
    ["request+init", (vf, signal) => vf(new Request(URL_A), { signal })],
  ];
  for (const [label, run] of entries) {
    const h = harness({ decision: slowDecision });
    const controller = new AbortController();
    const vet402Fetch = createVet402Fetch({ account: h.account, fetch: h.fetchImpl });
    const work = run(vet402Fetch, controller.signal).catch((err) => err);
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < 8; i += 1) {
      globalThis.gc?.();
    }
    controller.abort();
    const err = await work;
    assert.ok(err?.name === "AbortError" || err === controller.signal.reason, label);
    assert.equal(h.seen.signatures, 0, label);
    assert.equal(h.seen.seller.filter((c) => c.paid).length, 0, label);
  }
});

test("abort during signTypedData rejects with failed signed vet402PayResult and no paid seller call (string and request)", async () => {
  const entries = [
    ["string", (vf, signal) => vf(URL_A, { signal })],
    ["request", (vf, signal) => vf(new Request(URL_A, { signal }))],
  ];
  for (const [label, run] of entries) {
    const h = harness();
    const controller = new AbortController();
    const innerSign = h.account.signTypedData.bind(h.account);
    h.account.signTypedData = async (...args) => {
      controller.abort();
      return innerSign(...args);
    };
    const vet402Fetch = createVet402Fetch({ account: h.account, fetch: h.fetchImpl });
    const err = await run(vet402Fetch, controller.signal).catch((e) => e);
    assert.equal(err?.name, "AbortError", label);
    assert.ok(err.vet402PayResult, label);
    assert.equal(err.vet402PayResult.status, "failed", label);
    assert.equal(err.vet402PayResult.signed, true, label);
    assert.equal(h.seen.seller.filter((c) => c.paid).length, 0, label);
    assert.equal(h.seen.signatures, 1, label);
  }
});

test("abort after paid headers reach the seller attests once with paid vet402PayResult (signal-respecting and ignoring fetch)", async () => {
  const slowPaid = (account) =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            new Response('{"answer":42}', {
              status: 200,
              headers: {
                "payment-response": b64({
                  success: true,
                  transaction: `0x${"cd".repeat(32)}`,
                  network: "eip155:8453",
                  payer: account.address,
                }),
              },
            }),
          ),
        80,
      ),
    );
  for (const [label, respectSignal] of [
    ["respecting signal", true],
    ["ignoring signal on paid fetch", false],
  ]) {
    let attests = 0;
    const h = harness();
    const controller = new AbortController();
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === `${API}/payments/x402` && init.method === "POST") {
        attests += 1;
        return respectSignal
          ? new Promise((resolve) => setTimeout(() => resolve(json(200, { ok: true })), 30))
          : json(200, { ok: true });
      }
      if (!respectSignal && url === URL_A) {
        const headers = new Headers(init.headers);
        if (headers.has("payment-signature")) {
          h.seen.seller.push({
            method: (init.method ?? "GET").toUpperCase(),
            paid: true,
            paymentSignature: headers.get("payment-signature"),
          });
          return slowPaid(h.account);
        }
      }
      if (respectSignal && init.signal?.aborted) {
        throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      return h.fetchImpl(input, init);
    };
    const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
    const work = vet402Fetch(URL_A, { signal: controller.signal }).catch((err) => err);
    for (let i = 0; i < 200 && !h.seen.seller.some((c) => c.paid); i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(h.seen.seller.some((c) => c.paid), label);
    controller.abort();
    const err = await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    assert.equal(err?.name, "AbortError", label);
    assert.ok(err.vet402PayResult, label);
    assert.equal(err.vet402PayResult.status, "paid", label);
    assert.ok(err.vet402PayResult.txHash, label);
    assert.equal(attests, 1, label);
  }
});

test("signed payment then abort exposes signed true on vet402PayResult", async () => {
  const h = harness();
  const controller = new AbortController();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/`)) return h.fetchImpl(input, init);
    const headers = new Headers(init.headers);
    if (headers.has("payment-signature")) {
      controller.abort();
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response("{}", {
                status: 202,
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
          80,
        ),
      );
    }
    return challenge([offer()]);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const err = await vet402Fetch(URL_A, { signal: controller.signal }).catch((e) => e);
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.equal(err.vet402PayResult.status, "failed");
  assert.equal(err.vet402PayResult.signed, true);
});

test("abort after pay does not mutate signal.reason", async () => {
  const h = harness();
  const customReason = new DOMException("caller-abort", "AbortError");
  const controller = new AbortController();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === URL_A) {
      const headers = new Headers(init.headers);
      if (headers.has("payment-signature")) {
        controller.abort(customReason);
        return new Promise((resolve) => setTimeout(() => resolve(h.fetchImpl(input, init)), 80));
      }
    }
    return h.fetchImpl(input, init);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl });
  const err = await vet402Fetch(URL_A, { signal: controller.signal }).catch((e) => e);
  assert.notEqual(err, customReason);
  assert.equal(err.cause, customReason);
  assert.ok(err.vet402PayResult);
  assert.equal(err.vet402PayResult.status, "paid");
  assert.equal(Object.prototype.hasOwnProperty.call(customReason, "vet402PayResult"), false);
});

test("init signal undefined keeps an aborted Request input signal", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort(new DOMException("pre-abort", "AbortError"));
  const req = new Request(URL_A, { signal: controller.signal });
  await assert.rejects(h.vet402Fetch(req, { signal: undefined }), (err) => err === controller.signal.reason);
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller.length, 0);
});

test("paid seller slow body completes despite short requestTimeoutMs", async () => {
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
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl, requestTimeoutMs: 30 });
  const response = await vet402Fetch(URL_A);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "part1-part2-end");
});

test("vet402 decision body stall with signal-ignoring fetch aborts with caller signal", async () => {
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
  const controller = new AbortController();
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl, requestTimeoutMs: 500 });
  const work = vet402Fetch(URL_A, { signal: controller.signal }).catch((err) => err);
  setTimeout(() => controller.abort(), 30);
  const err = await Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 800)),
  ]);
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.equal(h.seen.signatures, 0);
});

test("vet402 decision body stall with signal-ignoring fetch stops within requestTimeoutMs", async () => {
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
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: fetchImpl, requestTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(vet402Fetch(URL_A), (err) => err instanceof Vet402RefusedError);
  assert.ok(Date.now() - started < 400);
  assert.equal(h.seen.signatures, 0);
});

test("vet402 read stops within requestTimeoutMs and caller abort without AbortSignal.any", async () => {
  const savedAny = AbortSignal.any;
  const h = harness({ decision: () => new Promise(() => {}) });
  delete AbortSignal.any;
  try {
    for (const [label, abortAt] of [
      ["timeout only", null],
      ["timeout and caller abort", 30],
    ]) {
      const inner = harness({ decision: () => new Promise(() => {}) });
      const fetchImpl = async (input, init = {}) => {
        const url = String(input);
        if (url.startsWith(`${API}/resources/`)) return new Promise(() => {});
        return inner.fetchImpl(input, init);
      };
      const controller = new AbortController();
      if (abortAt !== null) setTimeout(() => controller.abort(), abortAt);
      const vet402Fetch = createVet402Fetch({
        account: inner.account,
        fetch: fetchImpl,
        requestTimeoutMs: 80,
      });
      const started = Date.now();
      const err = await vet402Fetch(URL_A, abortAt === null ? undefined : { signal: controller.signal }).catch((e) => e);
      assert.ok(err?.name === "AbortError" || err instanceof Vet402RefusedError, label);
      assert.ok(Date.now() - started < 500, label);
      assert.equal(inner.seen.signatures, 0, label);
    }
  } finally {
    Object.defineProperty(AbortSignal, "any", { value: savedAny, configurable: true, writable: true });
  }
  void h;
});

test("abort vet402PayResult copies aborted into receipt.reason_codes", async () => {
  const h = harness();
  const controller = new AbortController();
  const innerSign = h.account.signTypedData.bind(h.account);
  h.account.signTypedData = async (...args) => {
    controller.abort();
    return innerSign(...args);
  };
  const vet402Fetch = createVet402Fetch({ account: h.account, fetch: h.fetchImpl });
  const err = await vet402Fetch(URL_A, { signal: controller.signal }).catch((e) => e);
  assert.equal(err?.name, "AbortError");
  assert.ok(err.vet402PayResult);
  assert.ok(err.vet402PayResult.reasonCodes.includes("aborted"));
  if (err.vet402PayResult.receipt !== null) {
    assert.ok(err.vet402PayResult.receipt.reason_codes.includes("aborted"));
  }
});

test("init.signal null ignores an abort on the Request input signal", async () => {
  const h = harness();
  const controller = new AbortController();
  const req = new Request(URL_A, { signal: controller.signal });
  const work = h.vet402Fetch(req, { signal: null });
  setTimeout(() => controller.abort(), 10);
  const response = await Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
  ]);
  assert.equal(response.status, 200);
});