import assert from "node:assert/strict";

export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAY_TO = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
export const URL_A = "https://seller.example/v1/search";
export const URL_OTHER = "https://other.example/v1/search";
export const API = "https://vet402.com/api/v1";
export const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

export const offer = (over = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});

export const challenge = (accepts) =>
  new Response("{}", {
    status: 402,
    headers: { "payment-required": b64({ x402Version: 2, resource: { url: URL_A }, accepts }) },
  });

export const verdict = (recommendation, over = {}) => ({
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

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function harness({ decision = () => json(200, verdict("ALLOW")), offers = () => [offer()], paidBody = '{"answer":42}' } = {}) {
  const seen = { seller: 0, decisions: 0, signatures: 0, vet402: 0 };
  const account = {
    address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
    signTypedData: async () => {
      seen.signatures += 1;
      return `0x${"ab".repeat(65)}`;
    },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${API}/`)) {
      seen.vet402 += 1;
      if (url.startsWith(`${API}/resources/`)) seen.decisions += 1;
      return decision(url);
    }
    seen.seller += 1;
    const headers = new Headers(init.headers);
    if (headers.has("payment-signature")) {
      return new Response(paidBody, {
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
    return challenge(offers());
  };
  return { seen, account, fetchImpl };
}

export function parseResult(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  return raw;
}

export function assertNoSecrets(result) {
  const text = JSON.stringify(result);
  assert.equal(text.includes("payment-signature"), false);
  assert.equal(text.includes("0xab"), false);
}