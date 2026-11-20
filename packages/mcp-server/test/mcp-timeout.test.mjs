// payaudit-02: paid seller retry must not use vet402 read timeout; second sign blocked while live.
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { payIfTrusted } from "../dist/pay-if-trusted.js";

const PAYEE = "0x1111111111111111111111111111111111111111";
const RID = "a".repeat(64);
const challenge = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "10000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: PAYEE,
        maxTimeoutSeconds: 60,
      },
    ],
  }),
).toString("base64");

test("failed settlement: one sign, validBefore on FAILED, second call refused while live", async () => {
  const seller = http.createServer((req, res) => {
    const sig = req.headers["payment-signature"];
    if (!sig) {
      res.writeHead(402, { "payment-required": challenge });
      return res.end();
    }
    setTimeout(() => {
      res.writeHead(500);
      res.end("seller error");
    }, 100);
  });
  await new Promise((r) => seller.listen(0, "127.0.0.1", r));
  const resource = `http://127.0.0.1:${seller.address().port}/paid`;
  let signCalls = 0;
  const signer = {
    address: "0x2222222222222222222222222222222222222222",
    signTypedData: async () => {
      signCalls++;
      return "0x" + "11".repeat(65);
    },
  };
  const timeoutMs = 500;
  const boundedFetch = (url, init) => {
    const u = String(url);
    if (u.includes("api.stub")) {
      if (u.includes("/resolve")) {
        return Promise.resolve(new Response(JSON.stringify({ resource: { resource_id: RID } }), { status: 200 }));
      }
      if (u.includes("/decision")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              recommendation: "ALLOW",
              degraded: false,
              reason_codes: [],
              facts: {},
              evidence: [],
              rules_version: "stub",
              scoredAt: new Date().toISOString(),
              cacheExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              verified_terms: {
                pay_to: PAYEE,
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                amount: "10000",
                network: "eip155:8453",
                scheme: "exact",
                decimals: 6,
                protocol: "x402",
                verified_at: new Date().toISOString(),
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  };
  const first = await payIfTrusted({
    resourceId: RID,
    signer,
    fetch: boundedFetch,
    apiUrl: "https://api.stub",
    resource,
    payee: PAYEE,
    amountUsd: 0.01,
    maxPerTxUsd: 1,
  });
  const second = await payIfTrusted({
    resourceId: RID,
    signer,
    fetch: boundedFetch,
    apiUrl: "https://api.stub",
    resource,
    payee: PAYEE,
    amountUsd: 0.01,
    maxPerTxUsd: 1,
  });
  seller.close();
  assert.equal(first.decision, "FAILED");
  assert.ok(first.validBefore);
  assert.equal(second.decision, "REFUSE");
  assert.equal(signCalls, 1);
});