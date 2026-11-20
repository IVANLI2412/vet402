// Signed payment retries must not follow redirects and must target https sellers (A-02).
import test from "node:test";
import assert from "node:assert/strict";

const { payOrRefuse } = await import("../dist/index.js");
const { executeX402Payment: executeX402 } = await import("../dist/x402-pay.js");

const PAY_TO = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const PAYER = "0xDB62BD202914609830fA656F87996b91be3Aa673";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DECISION = "/decision";

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function decision() {
  return {
    status: 200,
    body: {
      subject: { type: "resource", id: "a".repeat(64) },
      role: "payer",
      recommendation: "ALLOW",
      reason_codes: ["l0_pass"],
      facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
      evidence: [],
      degraded: false,
      policy: "allow_only",
      rules_version: "test",
    },
  };
}

const okAccept = {
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC,
  amount: "20000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

function challenge(url) {
  return b64({ x402Version: 2, resource: { url }, accepts: [okAccept] });
}

test("executeX402Payment sends redirect:error and rejects http resources", async () => {
  const redirects = [];
  const fetchFn = async (url, init) => {
    redirects.push(init?.redirect);
    return new Response("{}", { status: 200, headers: { "payment-response": b64({ success: true, transaction: "0xtx" }) } });
  };
  await assert.rejects(
    () =>
      executeX402({
        account: { address: PAYER, signTypedData: async () => "0xsig" },
        accept: okAccept,
        resource: "http://insecure.example/item",
        method: "GET",
        chainId: 8453,
        profile: { name: "base", network: "eip155:8453", chainId: 8453, asset: USDC, usdcEip712: { name: "USD Coin", version: "2" }, v1Slug: "base", attest: true },
        x402Version: 2,
        fetch: fetchFn,
      }),
    /invalid_url/,
  );
  const r = await executeX402({
    account: { address: PAYER, signTypedData: async () => "0xsig" },
    accept: okAccept,
    resource: "https://seller.example/item",
    method: "GET",
    chainId: 8453,
    profile: { name: "base", network: "eip155:8453", chainId: 8453, asset: USDC, usdcEip712: { name: "USD Coin", version: "2" }, v1Slug: "base", attest: true },
    x402Version: 2,
    fetch: fetchFn,
  });
  assert.equal(r.signed, true);
  assert.ok(redirects.every((m) => m === "error"));
});

test("payOrRefuse: signed retry uses redirect error so a 302 cannot carry the header onward", async () => {
  const resource = "https://kronossignals.com/api/v1/price/btc";
  const paidRedirects = [];
  let signs = 0;
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/resources/") && u.includes("/decision")) {
      return new Response(JSON.stringify(decision().body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!u.includes("kronossignals")) throw new Error(`forbidden: ${u}`);
    const hdr = init?.headers ?? {};
    const paid = hdr["PAYMENT-SIGNATURE"] ?? hdr["payment-signature"];
    if (!paid) {
      return new Response(null, { status: 402, headers: { "payment-required": challenge(resource) } });
    }
    paidRedirects.push(init?.redirect);
    if (init?.redirect === "error") throw new TypeError("unexpected redirect");
    throw new Error("redirect target must never run");
  };
  const r = await payOrRefuse({
    payee: PAY_TO,
    resource,
    amountUsd: 0.02,
    account: {
      address: PAYER,
      signTypedData: async () => {
        signs += 1;
        return `0x${"11".repeat(65)}`;
      },
    },
    fetch: fetchFn,
    policy: { evidence: { minL1Deliveries: 3, source: "vet402" } },
  });
  assert.equal(paidRedirects.length, 1, "one signed retry with redirect guard");
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.equal(signs, 1);
  assert.ok(paidRedirects.every((m) => m === "error"));
});