// whitehat-1 / payaudit-1 / adversary-2: the tool's evidence floors survive the env merge
// all the way to the signer. Composes the same calls the pay_if_trusted handler makes
// (policyFromEnv → mergePolicyFromEnv → payIfTrusted) and pins the handler wiring by source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { payIfTrusted } from "../dist/pay-if-trusted.js";
import { policyFromEnv, mergePolicyFromEnv } from "../dist/policy-env.js";
import { allowDecisionBody } from "./helpers/decision.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
};
const b64 = (o) => btoa(JSON.stringify(o));

function harness(nDelivered) {
  const seen = { signs: 0 };
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) {
      const body = allowDecisionBody(ACCEPT, {
        facts: { l0: { status: "pass" }, l1: { n_delivered: nDelivered, n_attempts: nDelivered } },
      });
      return { ok: true, status: 200, json: async () => body, headers: new Map() };
    }
    if (u.includes("/resolve")) {
      return { ok: true, status: 200, json: async () => ({ resource: { resource_id: "a".repeat(64) } }), headers: new Map() };
    }
    if (u.includes("/payments/x402")) return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    const paid = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
    if (!paid) {
      return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [ACCEPT] })]]) };
    }
    return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
  };
  const signer = {
    address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
    signTypedData: async () => {
      seen.signs += 1;
      return "0x" + "11".repeat(65);
    },
  };
  return { fetch, signer, seen };
}

async function run(env, toolPolicy, nDelivered) {
  const h = harness(nDelivered);
  const policy = mergePolicyFromEnv(policyFromEnv(env), toolPolicy);
  const r = await payIfTrusted({
    resourceId: "a".repeat(64),
    signer: h.signer,
    fetch: h.fetch,
    apiUrl: "https://api.stub",
    resource: "https://gateway.example/api/data",
    payee: PAYEE,
    amountUsd: 0.01,
    maxPerTxUsd: 1,
    policy,
  });
  return { r, signs: h.seen.signs, policy };
}

const TOOL_FLOOR_5 = { requireVet402Allow: true, evidence: { source: "vet402", minL1Deliveries: 5 } };

test("default env + tool floor 5 + 0 deliveries → REFUSE and the signer is never called", async () => {
  const { r, signs, policy } = await run({}, TOOL_FLOOR_5, 0);
  assert.equal(policy.evidence?.minL1Deliveries, 5, "merge dropped the tool floor");
  assert.equal(r.decision, "REFUSE", JSON.stringify(r));
  assert.equal(signs, 0);
});

test("waiver env + tool floor 5 + 0 deliveries → still REFUSE, 0 signatures", async () => {
  const { r, signs } = await run({ VOUCH_ALLOW_WAIVE_VET402: "1" }, TOOL_FLOOR_5, 0);
  assert.equal(r.decision, "REFUSE", JSON.stringify(r));
  assert.equal(signs, 0);
});

test("control: same floor with 6 deliveries reaches the signer exactly once", async () => {
  const { r, signs } = await run({}, TOOL_FLOOR_5, 6);
  assert.equal(signs, 1, JSON.stringify(r));
});

test("handler wiring: merged policy is what payIfTrusted gets, and the cap is reserved before the await", () => {
  const src = readFileSync(join(PKG, "src/index.ts"), "utf8");
  const merge = src.indexOf("const effectivePolicy = mergePolicyFromEnv(envPolicy, policy);");
  const reserve = src.indexOf("tryReserveSessionSpend(amountUsd, cap)");
  const call = src.indexOf("const result = await payIfTrusted({", reserve);
  assert.ok(merge > 0 && reserve > merge && call > reserve, "order: merge → reserve → payIfTrusted");
  const callBlock = src.slice(call, src.indexOf("});", call));
  assert.match(callBlock, /policy: effectivePolicy,/);
  assert.doesNotMatch(src.slice(reserve, call), /\bawait\b/, "an await between reserve and the call reopens the race");
});
