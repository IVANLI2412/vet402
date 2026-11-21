// payaudit-3: a silent seller after signing must return failed within the authorization /
// blockhash life. Time is mocked (setTimeout + Date), so the test runs in milliseconds and a
// build without the deadline fails instead of hanging.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { executeX402Payment, MAX_AUTHORIZATION_WINDOW_SECONDS } from "../dist/x402-pay.js";
import { executeSvmPayment, SVM_BLOCKHASH_LIFETIME_MS } from "../dist/svm-pay.js";

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAYEE,
  maxTimeoutSeconds: 3,
};

/** A seller that never answers the paid request. Records when (mocked clock) the abort fired. */
function silentSeller({ isPaid, onOther }) {
  const seen = { abortedAtMs: null, paidCalls: 0 };
  const fetchFn = async (url, init) => {
    if (!isPaid(url, init)) return onOther(url, init);
    seen.paidCalls += 1;
    return new Promise((_, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        seen.abortedAtMs = Date.now();
        reject(signal.reason);
      };
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      // Advance the mocked clock well past every window, then give up so a build
      // without a deadline fails the assertions below instead of hanging forever.
      // Step the clock 1 s at a time (the mock stamps Date with the end of a tick, not the timer's time).
      setImmediate(() => {
        for (let s = 0; s < 600 && seen.abortedAtMs === null; s++) mock.timers.tick(1000);
        setImmediate(() => {
          if (seen.abortedAtMs === null) reject(new Error("no deadline on the paid request"));
        });
      });
    });
  };
  return { fetchFn, seen };
}

test("executeX402Payment: silent seller is aborted within the authorization window", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const { fetchFn, seen } = silentSeller({
    isPaid: (_u, init) => Boolean(init?.headers?.["PAYMENT-SIGNATURE"] ?? init?.headers?.["payment-signature"]),
    onOther: async () =>
      new Response(null, { status: 402, headers: { "payment-required": btoa(JSON.stringify({ x402Version: 2, accepts: [ACCEPT] })) } }),
  });
  const t0 = Date.now();
  const r = await executeX402Payment({
    account: { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0x" + "11".repeat(65) },
    accept: ACCEPT,
    resource: RESOURCE,
    method: "GET",
    chainId: 8453,
    x402Version: 2,
    fetch: fetchFn,
  });
  assert.equal(seen.paidCalls, 1);
  assert.notEqual(seen.abortedAtMs, null, "paid request had no deadline");
  const waited = seen.abortedAtMs - t0;
  // window = clamp(maxTimeoutSeconds, 60, MAX) → 60 s for maxTimeoutSeconds 3.
  assert.ok(waited >= 60_000 && waited <= MAX_AUTHORIZATION_WINDOW_SECONDS * 1000, `aborted after ${waited}ms`);
  assert.equal(r.signed, true);
  assert.equal(r.settled, false);
  assert.ok(r.nonce);
});

test("executeSvmPayment: silent seller is aborted within the blockhash life", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const kp = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n));
  const PAYER = kp(1);
  const RPC_URL = "https://rpc.solana.example/";
  const { fetchFn, seen } = silentSeller({
    isPaid: (url) => url !== RPC_URL,
    onOther: async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: kp(3).publicKey.toBase58() } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const t0 = Date.now();
  const r = await executeSvmPayment({
    account: { address: PAYER.publicKey.toBase58(), signTransaction: async (tx) => { tx.sign([PAYER]); return tx; } },
    rpcUrl: RPC_URL,
    accept: {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "20000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: kp(7).publicKey.toBase58(),
      maxTimeoutSeconds: 60,
      extra: { feePayer: kp(9).publicKey.toBase58() },
    },
    resource: "https://sol-seller.example/api/v1/price/sol",
    method: "GET",
    fetch: fetchFn,
  });
  assert.equal(r.refused, null, JSON.stringify(r));
  assert.equal(seen.paidCalls, 1);
  assert.notEqual(seen.abortedAtMs, null, "paid request had no deadline");
  const waited = seen.abortedAtMs - t0;
  assert.ok(waited > 0 && waited <= SVM_BLOCKHASH_LIFETIME_MS, `aborted after ${waited}ms`);
  assert.equal(r.signed, true);
  assert.equal(r.sent, true);
  assert.equal(r.settled, false);
});
