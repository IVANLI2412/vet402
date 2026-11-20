// adversary-3 / payaudit-03: resolve で正規 id・404 の host_known を読む。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pay } from "../dist/index.js";

const PAYTO = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LISTED = "https://blocked-seller.example/api/data";
const VARIANT = `${LISTED}?ref=1`;
const idOf = (u) => createHash("sha256").update(`GET ${u}`).digest("hex");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const challenge = b64({
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000000", asset: USDC, payTo: PAYTO }],
});

test("URL variant with allowUnknown: variant is refused when host_known is not false", async () => {
  const asked = [];
  const signed = [];
  const stubFetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init.headers);
    const paid = h.has("payment-signature") || h.has("x-payment");
    if (url.includes("/resolve")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      return Response.json(
        q === LISTED
          ? { resource: { resource_id: idOf(LISTED) } }
          : { resource: null, endpoints: [] },
      );
    }
    if (url.includes("/decision")) {
      asked.push(url.includes(idOf(LISTED)) ? "listed" : "variant");
      if (url.includes(idOf(LISTED))) {
        return Response.json({
          recommendation: "BLOCK",
          reason_codes: ["l1_paid_not_delivered"],
          degraded: false,
          facts: {},
          evidence: [],
          rules_version: "stub",
          scoredAt: new Date().toISOString(),
        });
      }
      return Response.json({ error: "not_found", host_known: null }, { status: 404 });
    }
    if (url.includes("/payees/")) {
      return Response.json({ recommendation: "ALLOW", score: 80, degraded: false, signalsUnavailable: [] });
    }
    if (url.includes("/payments/x402")) return new Response("{}");
    if (!paid) return new Response(null, { status: 402, headers: { "payment-required": challenge } });
    return new Response("{}", { status: 200, headers: { "payment-response": b64({ success: true, transaction: "0x" + "cd".repeat(32) }) } });
  };
  const account = {
    address: "0x3333333333333333333333333333333333333333",
    signTypedData: async () => (signed.push(1), "0x" + "00".repeat(65)),
  };
  const listed = await pay(LISTED, undefined, { account, fetch: stubFetch, allowUnknown: true, apiKey: "stub" });
  const variant = await pay(VARIANT, undefined, { account, fetch: stubFetch, allowUnknown: true, apiKey: "stub" });
  assert.equal(listed.status, "refused");
  assert.equal(variant.status, "refused");
  assert.equal(signed.length, 0);
  assert.ok(variant.reasonCodes.includes("evidence_unavailable"));
  assert.match(String(asked), /variant/);
});