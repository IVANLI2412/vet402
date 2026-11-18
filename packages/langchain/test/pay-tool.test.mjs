import test from "node:test";
import assert from "node:assert/strict";
import { executeVet402Pay, RESPONSE_BODY_CAP } from "../dist/index.js";
import {
  URL_A,
  URL_OTHER,
  harness,
  json,
  assertNoSecrets,
  verdict,
} from "./_harness.mjs";

test("ALLOW pays once and returns the seller body", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "paid");
  assert.equal(r.recommendation, "ALLOW");
  assert.equal(h.seen.signatures, 1);
  assert.equal(r.responseBody, '{"answer":42}');
  assertNoSecrets(r);
});

test("BLOCK refuses with zero signatures", async () => {
  const h = harness({ decision: () => json(200, verdict("BLOCK")) });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("WARN refuses by default with zero signatures", async () => {
  const h = harness({ decision: () => json(200, verdict("WARN")) });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("uncatalogued URL refuses with zero signatures", async () => {
  const h = harness({ decision: () => json(404, { error: "not_found" }) });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("rejects policy fields coming from tool input", async () => {
  const h = harness();
  const r = await executeVet402Pay(
    { url: URL_A, allowWarn: true, allowUnknown: true },
    { account: h.account, fetch: h.fetchImpl },
  );
  assert.equal(r.reasonCodes[0], "tool_input_policy_field");
  assert.equal(h.seen.signatures, 0);
});

test("allowedHosts blocks off-list URLs before pay", async () => {
  const h = harness();
  const r = await executeVet402Pay(
    { url: URL_OTHER },
    { account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] },
  );
  assert.equal(r.reasonCodes[0], "host_not_allowed");
  assert.equal(h.seen.seller, 0);
  assert.equal(h.seen.vet402, 0);
});

test("forbidden headers are rejected before signing", async () => {
  const h = harness();
  const r = await executeVet402Pay(
    { url: URL_A, headers: { "x-payment": "sig" } },
    { account: h.account, fetch: h.fetchImpl },
  );
  assert.equal(r.reasonCodes[0], "forbidden_header");
  assert.equal(h.seen.signatures, 0);
});

test("long seller bodies are truncated", async () => {
  const body = "y".repeat(RESPONSE_BODY_CAP + 100);
  const h = harness({ paidBody: body });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.responseBodyTruncated, true);
});