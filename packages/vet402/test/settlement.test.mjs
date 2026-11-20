// Locked @vet402/sdk must treat empty transaction and 202 as unsettled (A-03).
import assert from "node:assert/strict";
import { test } from "node:test";
import { executeX402Payment } from "../node_modules/@vet402/sdk/dist/x402-pay.js";

const PAY_TO = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const PAYER = "0xDB62BD202914609830fA656F87996b91be3Aa673";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const accept = {
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC,
  amount: "20000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

const account = { address: PAYER, signTypedData: async () => `0x${"ab".repeat(65)}` };
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");

async function settle(status, settlement) {
  return executeX402Payment({
    account,
    accept,
    resource: "https://seller.example/v1/quote",
    method: "GET",
    chainId: 8453,
    profile: {
      name: "base",
      network: "eip155:8453",
      chainId: 8453,
      asset: USDC,
      usdcEip712: { name: "USD Coin", version: "2" },
      v1Slug: "base",
      attest: true,
    },
    x402Version: 2,
    fetch: async () =>
      new Response("{}", {
        status,
        headers: { "payment-response": b64(settlement) },
      }),
  });
}

test("success with empty transaction is not settled", async () => {
  const r = await settle(200, { success: true, transaction: "", network: "eip155:8453", payer: PAYER });
  assert.equal(r.signed, true);
  assert.equal(r.settled, false);
});

test("HTTP 202 with transaction id is not settled", async () => {
  const r = await settle(202, { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453", payer: PAYER });
  assert.equal(r.signed, true);
  assert.equal(r.settled, false);
});