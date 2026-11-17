// GET /api/v1/erc8004/check — Reputation Registry の proofOfPayment 再読。RPC・IPFS は差し替え。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Networks } from "@stellar/stellar-sdk";
import { keccak256, pad, toBytes, type Address, type Hex } from "viem";
import { STELLAR_USDC_ISSUER } from "@/lib/observatory/stellar402-payer";
import type { StellarHorizonReader } from "@/lib/observatory/settlement-verify-stellar";
import { BASE_USDC } from "@/lib/observatory/x402-payer";
import { hashFeedbackBody } from "@/lib/erc8004-check/feedback-uri";
import type { FeedbackLogSlice } from "@/lib/erc8004-check/registry-read";
import { runErc8004Check } from "@/lib/erc8004-check/run-check";

delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

const AGENT = 94639n;
const CLIENT = "0x7722DfAE6bbed2Fd02Dc07455c2f5BF14bE25E4a" as Address;
const PAYEE = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const TX = `0x${"cc".repeat(32)}` as Hex;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicAddr(addr: string): Hex {
  return pad(addr as Hex, { size: 32 });
}

function feedbackJson(proof: Record<string, unknown> | null): string {
  return JSON.stringify({ type: "ars-evidence/0.1", proofOfPayment: proof });
}

function makeLogSlice(body: string, index = 1n): FeedbackLogSlice {
  return {
    clientAddress: CLIENT,
    feedbackIndex: index,
    value: 100n,
    valueDecimals: 0,
    tag1: "reachable",
    tag2: "",
    endpoint: "https://agent402.tools/",
    feedbackURI: "data:application/json;base64," + Buffer.from(body, "utf8").toString("base64"),
    feedbackHash: hashFeedbackBody(body),
    blockNumber: 56_000_000n,
    txHash: TX,
  };
}

const defaultPayTargets = {
  owner: PAYEE,
  agentWallet: PAYEE,
  vet402PayTo: PAYEE,
  matchKind: "owner" as const,
};

function registryReader() {
  return {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getClients") return [CLIENT];
        if (functionName === "getLastIndex") return 1n;
        if (functionName === "readFeedback") return [100n, 0, "reachable", "", false];
        throw new Error("unexpected");
      },
    },
  };
}

function evmPaymentReader(to: string, from: string) {
  return {
    evm: async () => ({
      getChainId: async () => 8453,
      getBlockNumber: async () => 1n,
      getBlock: async () => ({ timestamp: 1_731_000_000n, number: 123n }),
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 123n,
        logs: [
          {
            address: BASE_USDC,
            topics: [TRANSFER, topicAddr(from), topicAddr(to)],
            data: `0x${(10_000n).toString(16).padStart(64, "0")}`,
          },
        ],
      }),
    }),
  };
}

function dataUriReader() {
  return async (uri: string) => ({
    body: Buffer.from(uri.split(",")[1], "base64").toString("utf8"),
    contentType: "application/json",
  });
}

function baseDeps(logSlice: FeedbackLogSlice, extra?: Record<string, unknown>) {
  return {
    readers: registryReader(),
    findFeedbackLog: async () => logSlice,
    resolvePayTargets: async () => defaultPayTargets,
    fetchFeedbackUri: dataUriReader(),
    ...extra,
  };
}

test("verified — proof とチェーンが一致", async () => {
  const body = feedbackJson({
    txHash: TX,
    chain: "eip155:8453",
    fromAddress: CLIENT,
    toAddress: PAYEE,
    amount: "10000",
  });
  const result = await runErc8004Check(
    { chain: "eip155:8453", agentId: "94639", client: CLIENT, feedbackIndex: "1" },
    {
      ...baseDeps(makeLogSlice(body)),
      paymentReaders: evmPaymentReader(PAYEE, CLIENT) as unknown as import("@/lib/payment-proof/chain").PaymentProofReaders,
      now: () => new Date("2026-11-17T00:00:00.000Z"),
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "verified");
  assert.equal(result.checks.tx_exists, "pass");
  assert.equal(result.checks.from_matches_client, "pass");
  assert.equal(result.checks.to_matches_agent_payTo_or_wallet, "pass");
});

test("mismatch — to がエージェントの payTo と違う", async () => {
  const wrongTo = "0x1111111111111111111111111111111111111111";
  const body = feedbackJson({
    txHash: TX,
    chain: "eip155:8453",
    fromAddress: CLIENT,
    toAddress: wrongTo,
    amount: "10000",
  });
  const result = await runErc8004Check(
    { agentId: "94639", client: CLIENT, feedbackIndex: "1" },
    {
      ...baseDeps(makeLogSlice(body)),
      paymentReaders: evmPaymentReader(wrongTo, CLIENT) as unknown as import("@/lib/payment-proof/chain").PaymentProofReaders,
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "mismatch");
  assert.deepEqual(result.reasons, ["recipient"]);
  assert.equal(result.checks.to_matches_agent_payTo_or_wallet, "fail");
});

test("no_proof — proofOfPayment が無い", async () => {
  const body = feedbackJson(null);
  const result = await runErc8004Check(
    { agentId: "94639", client: CLIENT, feedbackIndex: "1" },
    baseDeps(makeLogSlice(body)),
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "no_proof");
  assert.equal(result.proofOfPayment, null);
});

test("unreadable — feedback URI が読めない", async () => {
  const body = feedbackJson({ txHash: TX, chain: "eip155:8453" });
  const slice = makeLogSlice(body);
  slice.feedbackURI = "https://example.invalid/missing.json";
  const result = await runErc8004Check(
    { agentId: "94639", client: CLIENT, feedbackIndex: "1" },
    {
      ...baseDeps(slice),
      fetchFeedbackUri: async () => {
        throw new Error("http_404");
      },
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "unreadable");
});

test("mismatch — feedbackHash が本文と一致しない", async () => {
  const body = feedbackJson({ txHash: TX, chain: "eip155:8453", fromAddress: CLIENT, toAddress: PAYEE });
  const slice = makeLogSlice(body);
  slice.feedbackHash = keccak256(toBytes("other"));
  const result = await runErc8004Check(
    { agentId: "94639", client: CLIENT, feedbackIndex: "1" },
    baseDeps(slice),
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "mismatch");
  assert.deepEqual(result.reasons, ["feedback_hash"]);
  assert.equal(result.checks.feedback_hash, "fail");
});

const STELLAR_TX = "cd".repeat(32);
const STELLAR_FROM = `G${"A".repeat(55)}`;
const STELLAR_TO = `G${"B".repeat(55)}`;
const STELLAR_SPONSOR = `G${"C".repeat(55)}`;

function stellarHorizonFake(): StellarHorizonReader {
  return {
    root: async () => ({ network_passphrase: Networks.PUBLIC }),
    transaction: async (hash) =>
      hash === STELLAR_TX
        ? {
            hash: STELLAR_TX,
            id: STELLAR_TX,
            successful: true,
            ledger: 5_000_000,
            created_at: "2026-11-10T00:00:00Z",
            operation_count: 1,
            source_account: STELLAR_SPONSOR,
          }
        : null,
    operations: async () => ({
      _embedded: {
        records: [
          {
            type: "payment",
            from: STELLAR_FROM,
            to: STELLAR_TO,
            amount: "0.0100000",
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: STELLAR_USDC_ISSUER,
          },
        ],
      },
    }),
    effects: async () => ({ _embedded: { records: [] } }),
    account: async () => null,
  };
}

function stellarPaymentReaders() {
  return {
    stellar: async () => stellarHorizonFake(),
  };
}

test("verified_payment_unlinked_client — Stellar tx と EVM client（払い手を結べない）", async () => {
  const body = feedbackJson({
    txHash: STELLAR_TX,
    chain: "stellar:pubnet",
    fromAddress: STELLAR_FROM,
    toAddress: STELLAR_TO,
    amount: "100000",
    asset: `USDC:${STELLAR_USDC_ISSUER}`,
  });
  const result = await runErc8004Check(
    { agentId: "94639", client: CLIENT, feedbackIndex: "1" },
    {
      ...baseDeps(makeLogSlice(body)),
      paymentReaders: stellarPaymentReaders() as unknown as import("@/lib/payment-proof/chain").PaymentProofReaders,
    },
  );
  assert.ok(!("error" in result));
  assert.equal(result.verdict, "verified_payment_unlinked_client");
  assert.equal(result.checks.tx_exists, "pass");
  assert.equal(result.checks.from_matches_client, "unknown");
});

test("llms.txt・docs・openapi に erc8004/check がある", () => {
  const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.ok(llms.includes("GET /api/v1/erc8004/check"));
  const docs = readFileSync(new URL("../src/app/docs/api/page.tsx", import.meta.url), "utf8");
  assert.ok(docs.includes('path: "/api/v1/erc8004/check"'));
  const openapi = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
  assert.ok(openapi.includes("/api/v1/erc8004/check:"));
});

test("invalid_agent_id", async () => {
  const result = await runErc8004Check({ agentId: "abc", client: CLIENT });
  assert.deepEqual(result, { error: "invalid_agent_id" });
});