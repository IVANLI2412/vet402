import test from "node:test";
import assert from "node:assert/strict";
import { bindVet402PayTool, executeVet402Pay, RESPONSE_BODY_CAP } from "../dist/index.js";
import {
  URL_A,
  URL_OTHER,
  harness,
  json,
  assertNoSecrets,
  verdict,
} from "./_harness.mjs";

const HOSTS = ["seller.example"];
const URL_B = "https://seller.example/v1/other";

function toolOpts(h, over = {}) {
  return bindVet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: HOSTS, ...over });
}

test("ALLOW pays once and returns the seller body", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h));
  assert.equal(r.status, "paid");
  assert.equal(r.recommendation, "ALLOW");
  assert.equal(h.seen.signatures, 1);
  assert.equal(r.responseBody, '{"answer":42}');
  assert.equal(r.responseBodyTruncated, false);
  assertNoSecrets(r);
});

test("BLOCK refuses with zero signatures", async () => {
  const h = harness({ decision: () => json(200, verdict("BLOCK")) });
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h));
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /payee_recommendation_block/);
});

test("WARN refuses by default with zero signatures", async () => {
  const h = harness({ decision: () => json(200, verdict("WARN")) });
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h));
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
});

test("uncatalogued URL refuses with zero signatures and no score fetch side effect", async () => {
  const h = harness({ decision: () => json(404, { error: "not_found" }) });
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h));
  assert.equal(r.status, "refused");
  assert.equal(h.seen.signatures, 0);
  assert.match(r.reasonCodes.join(","), /resource_uncatalogued/);
});

test("rejects policy fields coming from tool input", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A, maxUsd: 50, account: h.account }, toolOpts(h));
  assert.equal(r.status, "refused");
  assert.equal(r.reasonCodes[0], "tool_input_policy_field");
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller, 0);
});

test("missing allowedHosts is refused at runtime", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A }, { account: h.account, fetch: h.fetchImpl });
  assert.equal(r.reasonCodes[0], "allowed_hosts_required");
  assert.equal(h.seen.signatures, 0);
});

test("empty allowedHosts blocks every URL before pay", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h, { allowedHosts: [] }));
  assert.equal(r.reasonCodes[0], "host_not_allowed");
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller, 0);
});

test("allowedHosts blocks off-list URLs before pay with no seller traffic", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_OTHER }, toolOpts(h));
  assert.equal(r.status, "refused");
  assert.equal(r.reasonCodes[0], "host_not_allowed");
  assert.equal(h.seen.signatures, 0);
  assert.equal(h.seen.seller, 0);
  assert.equal(h.seen.vet402, 0);
});

test("allowedHosts matches explicit ports only", async () => {
  const h = harness();
  const url = "https://seller.example:8443/v1/search";
  const r = await executeVet402Pay({ url }, toolOpts(h, { allowedHosts: ["seller.example"] }));
  assert.equal(r.reasonCodes[0], "host_not_allowed");
  assert.equal(h.seen.seller, 0);

  const ok = await executeVet402Pay({ url }, toolOpts(h, { allowedHosts: ["seller.example:8443"] }));
  assert.equal(ok.status, "paid");
});

test("forbidden headers are rejected before signing", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A, headers: { Authorization: "Bearer secret" } }, toolOpts(h));
  assert.equal(r.status, "refused");
  assert.equal(r.reasonCodes[0], "forbidden_header");
  assert.equal(h.seen.signatures, 0);
});

test("Headers and Map header values are rejected", async () => {
  const h = harness();
  const rHeaders = await executeVet402Pay({ url: URL_A, headers: new Headers({ "x-test": "1" }) }, toolOpts(h));
  assert.equal(rHeaders.reasonCodes[0], "tool_input_invalid_headers");
  const rMap = await executeVet402Pay({ url: URL_A, headers: new Map([["x-test", "1"]]) }, toolOpts(h));
  assert.equal(rMap.reasonCodes[0], "tool_input_invalid_headers");
});

test("long seller bodies are truncated within the cap", async () => {
  const body = "x".repeat(RESPONSE_BODY_CAP + 500);
  const h = harness({ paidBody: body });
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h));
  assert.equal(r.status, "paid");
  assert.equal(r.responseBodyTruncated, true);
  assert.ok(r.responseBody.endsWith("...[truncated]"));
  assert.ok(r.responseBody.length <= RESPONSE_BODY_CAP);
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
  const opts = bindVet402PayTool({ account: h.account, fetch: missingReceiptFetch, allowedHosts: HOSTS });
  const r = await executeVet402Pay({ url: URL_A }, opts);
  assert.equal(r.status, "failed");
  assert.match(r.guidance, /Do not retry/i);
});

test("duplicate failed payments are blocked on the same tool instance", async () => {
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
  const opts = bindVet402PayTool({ account: h.account, fetch: missingReceiptFetch, allowedHosts: HOSTS });
  const first = await executeVet402Pay({ url: URL_A, method: "POST" }, opts);
  assert.equal(first.status, "failed");
  assert.equal(h.seen.signatures, 1);

  const second = await executeVet402Pay({ url: URL_A, method: "POST" }, opts);
  assert.equal(second.status, "refused");
  assert.equal(second.reasonCodes[0], "duplicate_payment_blocked");
  assert.match(second.guidance, /再試行しない/);
  assert.ok(second.receipt?.payTo);
  assert.equal(h.seen.signatures, 1);
  assertNoSecrets(second);
});

test("maxTotalUsd stops the second signed payment on one instance", async () => {
  const h = harness();
  const opts = toolOpts(h, { maxUsd: 0.01, maxTotalUsd: 0.01 });
  const first = await executeVet402Pay({ url: URL_A }, opts);
  assert.equal(first.status, "paid");
  const second = await executeVet402Pay({ url: URL_B }, opts);
  assert.equal(second.status, "refused");
  assert.equal(second.reasonCodes[0], "max_total_usd_exceeded");
  assert.equal(h.seen.signatures, 1);
});

test("maxTotalUsd reservations work under concurrent calls", async () => {
  const h = harness();
  const opts = toolOpts(h, { maxUsd: 0.01, maxTotalUsd: 0.01 });
  const [a, b] = await Promise.all([
    executeVet402Pay({ url: URL_A }, opts),
    executeVet402Pay({ url: URL_B }, opts),
  ]);
  const paid = [a, b].filter((r) => r.status === "paid");
  const blocked = [a, b].filter((r) => r.reasonCodes[0] === "max_total_usd_exceeded");
  assert.equal(paid.length, 1);
  assert.equal(blocked.length, 1);
  assert.equal(h.seen.signatures, 1);
});

test("fetch timeout returns refused without signatures", async () => {
  const h = harness();
  const slow = async (input) => {
    const url = String(input);
    if (url.startsWith("https://vet402.com/")) return h.fetchImpl(input);
    return new Promise(() => {});
  };
  const opts = toolOpts(h, { fetch: slow, fetchTimeoutMs: 50 });
  const r = await executeVet402Pay({ url: URL_A }, opts);
  assert.equal(r.reasonCodes[0], "fetch_timeout");
  assert.equal(h.seen.signatures, 0);
});

test("invalid SDK errors map to tool_execution_error", async () => {
  const h = harness();
  const r = await executeVet402Pay({ url: URL_A }, toolOpts(h, { network: "not-a-network" }));
  assert.equal(r.reasonCodes[0], "tool_execution_error");
});