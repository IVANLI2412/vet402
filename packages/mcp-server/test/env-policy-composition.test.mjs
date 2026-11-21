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

function harness(nDelivered, resolvedId = "a".repeat(64)) {
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
      return { ok: true, status: 200, json: async () => ({ resource: { resource_id: resolvedId } }), headers: new Map() };
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

test("tool source both + default env + no Graph key → REFUSE graph_key_not_configured, 0 signatures (R5-1/N4)", async () => {
  const h = harness(6);
  const policy = mergePolicyFromEnv(policyFromEnv({}), { evidence: { source: "both" } });
  assert.equal(policy.evidence?.source, "both");
  const r = await payIfTrusted({
    resourceId: "a".repeat(64), signer: h.signer, fetch: h.fetch, apiUrl: "https://api.stub",
    resource: "https://gateway.example/api/data", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, policy,
  });
  assert.equal(r.decision, "REFUSE", JSON.stringify(r));
  assert.ok(r.refuse_reasons.includes("graph_key_not_configured"), JSON.stringify(r.refuse_reasons));
  assert.equal(h.seen.signs, 0);
});

test("signer throws before signing → pending mark is cleared; the same resource can be paid next (N1/R5-4)", async () => {
  // 他の試験が払った資源と認可の鍵が重ならないよう、別の id を返す。
  const h = harness(6, "b".repeat(64));
  const base = {
    resourceId: "b".repeat(64), fetch: h.fetch, apiUrl: "https://api.stub",
    resource: "https://gateway.example/api/throws", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1,
  };
  // http:// の資源 URL は SDK が署名の前に throw する（adversary T5 の再現と同じ）。
  let first;
  try { first = await payIfTrusted({ ...base, signer: h.signer, resource: "http://gateway.example/api/throws" }); } catch (e) { first = e; }
  assert.ok(first instanceof Error, `expected a throw, got ${JSON.stringify(first)}`);
  assert.equal(h.seen.signs, 0);
  const r = await payIfTrusted({ ...base, signer: h.signer });
  assert.notEqual(r.decision, "REFUSE", `still blocked after a throw: ${JSON.stringify(r)}`);
  assert.equal(h.seen.signs, 1);
});

test("handler wiring: a throw from payIfTrusted releases the session reservation (N1/R5-4)", () => {
  const src = readFileSync(join(PKG, "src/index.ts"), "utf8");
  const call = src.indexOf("const result = await payIfTrusted({");
  const before = src.slice(Math.max(0, call - 300), call);
  const after = src.slice(call, call + 6000);
  assert.match(before, /if \(typeof amountUsd === "number"\) reservedUsd = amountUsd;/, "reservation is not recorded before the call");
  assert.match(after, /reservedUsd = null;/, "reservation is not cleared once payIfTrusted returns");
  assert.match(after, /catch \(error\) \{\n\s+if \(reservedUsd !== null\) releaseSessionSpend\(reservedUsd\);\n\s+return scoreToolFailure\(error\);/);
});
