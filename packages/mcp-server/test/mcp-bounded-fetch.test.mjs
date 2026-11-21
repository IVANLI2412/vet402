import test from "node:test";
import assert from "node:assert/strict";
import {
  createMcpBoundedFetch,
  paidSellerWaitMs,
  validBeforeSecFromPaymentHeaders,
  MAX_PAID_SELLER_WAIT_MS,
} from "../dist/mcp-bounded-fetch.js";

test("paidSellerWaitMs respects validBefore and caps at 120s", () => {
  assert.equal(paidSellerWaitMs(null, 0), MAX_PAID_SELLER_WAIT_MS);
  assert.equal(paidSellerWaitMs(100, 50_000), 50_000);
  assert.equal(paidSellerWaitMs(2000, 0), MAX_PAID_SELLER_WAIT_MS);
  assert.equal(paidSellerWaitMs(10, 9_500), 500);
});

test("validBeforeSecFromPaymentHeaders reads authorization.validBefore", () => {
  const body = {
    x402Version: 2,
    payload: { authorization: { validBefore: "1730000100" }, signature: "0xab" },
  };
  const headers = new Headers({ "payment-signature": Buffer.from(JSON.stringify(body)).toString("base64") });
  assert.equal(validBeforeSecFromPaymentHeaders(headers), 1730000100);
});

test("paid seller retry stops waiting when validBefore is reached", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const validBefore = nowSec + 1;
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://seller.example/item" },
      accepted: {},
      payload: { authorization: { validBefore: String(validBefore) }, signature: "0x" + "11".repeat(65) },
    }),
  ).toString("base64");
  let fetches = 0;
  const hanging = (url, init) => {
    fetches += 1;
    return new Promise((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort);
    });
  };
  const wrapped = createMcpBoundedFetch("https://api.stub/v1", 10_000, hanging, () => validBefore * 1000 - 500);
  const started = Date.now();
  await assert.rejects(
    wrapped("https://seller.example/item", { headers: { "payment-signature": header } }),
    (err) => err?.name === "TimeoutError" || err?.name === "AbortError",
  );
  assert.equal(fetches, 1);
  assert.ok(Date.now() - started < 3000, "should not hang until default 120s");
});

test("paid seller retry returns when the seller answers before validBefore", async () => {
  const validBefore = Math.floor(Date.now() / 1000) + 60;
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      payload: { authorization: { validBefore: String(validBefore) }, signature: "0x" + "22".repeat(65) },
    }),
  ).toString("base64");
  const wrapped = createMcpBoundedFetch("https://api.stub/v1", 10_000, async () => new Response("ok", { status: 200 }));
  const res = await wrapped("https://seller.example/item", { headers: { "payment-signature": header } });
  assert.equal(res.status, 200);
});