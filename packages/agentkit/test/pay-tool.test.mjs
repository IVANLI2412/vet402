import test from "node:test";
import assert from "node:assert/strict";
import { executeVet402Pay, RESPONSE_BODY_CAP } from "../dist/index.js";
import {
  URL_A,
  URL_OTHER,
  harness,
  json,
  parseResult,
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
  assert.equal(r.responseBodyTruncated, false);
  assertNoSecrets(r);
});

test("BLOCK refuses with zero signatures", async () => {
  const h = harness({ decision: () => json(200, verdict("BLOCK")) });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /payee_recommendation_block/);
});

test("WARN refuses by default with zero signatures", async () => {
  const h = harness({ decision: () => json(200, verdict("WARN")) });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("uncatalogued URL refuses with zero signatures and no score fetch side effect", async () => {
  const h = harness({ decision: () => json(404, { error: "not_found" }) });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /resource_uncatalogued/);
});

test("rejects policy fields coming from tool input", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A, maxUsd: 50, account: h.account }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "refused");
  assert.equal(r.reasonCodes[0], "tool_input_policy_field");
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller, 0);
});

test("allowedHosts blocks off-list URLs before pay with no seller traffic", async () => {
  const h = harness();
  const r = await executeVet402Pay(
    { url: URL_OTHER },
    { account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] },
  );
  assert.equal(r.status, "refused");
  assert.equal(r.reasonCodes[0], "host_not_allowed");
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller, 0);
  assert.equal(h.seen.vet402, 0);
});

test("forbidden headers are rejected before signing", async () => {
  const h = harness();
  const r = await executeVet402Pay(
    { url: URL_A, headers: { Authorization: "Bearer secret" } },
    { account: h.account, fetch: h.fetchImpl },
  );
  assert.equal(r.status, "refused");
  assert.equal(r.reasonCodes[0], "forbidden_header");
  assert.equal(h.seen.signatures, 0);
});

test("long seller bodies are truncated", async () => {
  const body = "x".repeat(RESPONSE_BODY_CAP + 500);
  const h = harness({ paidBody: body });
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.status, "paid");
  assert.equal(r.responseBodyTruncated, true);
  assert.ok(r.responseBody.endsWith("...[truncated]"));
  assert.ok(r.responseBody.length < body.length);
});

test("failed status tells the agent not to retry", async () => {
  const h = harness();
  const missingReceiptFetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://vet402.com/")) return h.fetchImpl(input, init);
    const headers = new Headers(init.headers);
    if (headers.has("payment-signature")) {
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }
    return h.fetchImpl(input, init);
  };
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: missingReceiptFetch });
  assert.equal(r.status, "failed");
  assert.match(r.guidance, /Do not retry/i);
});