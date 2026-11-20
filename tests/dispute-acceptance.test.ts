// ============================================================
// P2d — 争いの窓口（主張と鎖の事実）合格試験（DB なし）。
// ============================================================
process.env.PROXY_HEADER_SOURCE = "generic";

import { apiDocsPageText } from "./lib/api-docs-source";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashPaymentInfo as sdkHashPaymentInfo } from "../packages/sdk/src/auth-capture-pay.js";
import { AUTH_CAPTURE_EIP3009_COLLECTOR_V1_1 } from "../packages/sdk/src/auth-capture.js";
import {
  AUTH_CAPTURE_ESCROW_ABI,
  AUTH_CAPTURE_AUTHORIZE_SELECTOR,
  authorizeTxVisibleAtBlock,
  classifyEscrowCall,
  decodeAuthorizePaymentInfo,
  setE6ChainReaderForTests,
  type E6ChainReader,
} from "@/lib/observatory/e6-chain-reader";
import {
  tradeDisputeDeliveryReceiptMessage,
  tradeDisputeLegSignMessage,
  TRADE_DISPUTE_CHAIN,
} from "@/lib/observatory/e6-leg-sign";
import { hashDeliveredBody } from "@/lib/observatory/e6-record";
import {
  commitmentsForUtcDay,
  tradeDisputeDayPayload,
  tradeDisputeDayRootHash,
} from "@/lib/observatory/e6-anchors";
import { countPublicTradeDisputes } from "@/lib/dashboard/ops-data";
import { buildSellerCard } from "@/lib/dashboard/ops-card";
import { p2PartyAccessMessage } from "@/lib/observatory/p2-party-verify";
import { SIGNING_DOMAIN } from "@/lib/verify-message";
import {
  hashPaymentInfo,
  legCommitment,
  parseAuthCapturePaymentInfo,
  P2_CLAIMS_NOTE,
  P2_DISPUTE_PAGE_PATH,
  type AuthCapturePaymentInfoTuple,
} from "@/lib/observatory/trade-dispute";
import {
  resetTradeDisputeWriteLimitsForTests,
  setTradeDisputeWriteLimitsForTests,
} from "@/lib/observatory/trade-dispute-write-limits";
import { submitTradeDisputeLeg } from "@/lib/observatory/trade-dispute-submit";
import {
  memoryTradeDisputeStore,
  publicJsonForTrade,
  setTradeDisputeStoreForTests,
  type TradeDisputeLegRow,
  type TradeDisputeStore,
} from "@/lib/observatory/trade-dispute-store";
import { tradeDisputeDisplayRows } from "@/components/connect/trade-dispute-display";

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;/;
const FORBIDDEN_VERDICT_WORDS = /not_paid|not_delivered|content_changed|verdict|fault/i;

const ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const CHAIN_ID = 84532;

const PAYER = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const SELLER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ROGUE = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

function bodySha(body: string): string {
  return hashDeliveredBody(body);
}

function issuedNow(): string {
  return new Date().toISOString();
}

type PaymentInfoParties = {
  operator?: string;
  payer?: string;
  receiver?: string;
};

function defaultPaymentInfo(salt = 42n, parties: PaymentInfoParties = {}): AuthCapturePaymentInfoTuple {
  const now = Math.floor(Date.now() / 1000);
  const receiver = parties.receiver ?? SELLER.address;
  return {
    operator: parties.operator ?? receiver,
    payer: parties.payer ?? PAYER.address,
    receiver,
    token: USDC,
    maxAmount: 1_000_000n,
    preApprovalExpiry: now + 3600,
    authorizationExpiry: now + 7200,
    refundExpiry: now + 86_400,
    minFeeBps: 0,
    maxFeeBps: 100,
    feeReceiver: "0x0000000000000000000000000000000000000000",
    salt,
  };
}

function tradeIdFor(info: AuthCapturePaymentInfoTuple): string {
  return hashPaymentInfo(CHAIN_ID, info, info.payer.toLowerCase(), ESCROW);
}

function walletForIndex(i: number) {
  const hex = (0x1000n + BigInt(i)).toString(16).padStart(64, "0");
  return privateKeyToAccount(`0x${hex}`);
}

function paymentInfoTupleForAbi(info: AuthCapturePaymentInfoTuple) {
  return {
    operator: info.operator as Hex,
    payer: info.payer as Hex,
    receiver: info.receiver as Hex,
    token: info.token as Hex,
    maxAmount: BigInt(info.maxAmount),
    preApprovalExpiry: info.preApprovalExpiry,
    authorizationExpiry: info.authorizationExpiry,
    refundExpiry: info.refundExpiry,
    minFeeBps: info.minFeeBps,
    maxFeeBps: info.maxFeeBps,
    feeReceiver: info.feeReceiver as Hex,
    salt: BigInt(info.salt),
  };
}

function authorizeCalldata(info: AuthCapturePaymentInfoTuple): Hex {
  return encodeFunctionData({
    abi: AUTH_CAPTURE_ESCROW_ABI,
    functionName: "authorize",
    args: [paymentInfoTupleForAbi(info), 1_000_000n, USDC, "0x"],
  });
}

type ReaderTrace = {
  latestBlockReads: number;
  authorizeBlocks: number[];
  stateBlocks: number[];
  chainFactReads: number;
};

type MockChainOpts = {
  tradeId: string;
  info: AuthCapturePaymentInfoTuple;
  paymentTx?: string;
  /** ピンする最新ブロック N */
  blockNumber?: number;
  /** tx が入ったブロック（省略時は blockNumber と同じ） */
  txBlockNumber?: number;
  chainUnavailable?: boolean;
  txMissing?: boolean;
  txReverted?: boolean;
  escrowCallUnavailable?: boolean;
  /** 別 hash でも同じ authorize として読める tx（買い手と売り手が別 tx を名指しした試験用） */
  altPaymentTx?: string;
};

function mockChainReader(opts: MockChainOpts): { reader: E6ChainReader; trace: ReaderTrace; paymentTx: string } {
  const paymentTx = (opts.paymentTx ?? "0x" + "a".repeat(64)).toLowerCase();
  const altPaymentTx = opts.altPaymentTx?.toLowerCase();
  const isKnownPaymentTx = (txHash: string) => {
    const h = txHash.toLowerCase();
    return h === paymentTx || (altPaymentTx !== undefined && h === altPaymentTx);
  };
  const block = opts.blockNumber ?? 5_828_2443;
  const txBlock = opts.txBlockNumber ?? block;
  const trace: ReaderTrace = { latestBlockReads: 0, authorizeBlocks: [], stateBlocks: [], chainFactReads: 0 };
  const bumpChainReads = () => {
    trace.chainFactReads++;
  };
  const reader: E6ChainReader = {
    async readPaymentState() {
      return { collected: true, capturable: "1000", refundable: "0" };
    },
    async readPaymentStateAtBlock(_escrow, _hash, bn) {
      bumpChainReads();
      trace.stateBlocks.push(bn);
      if (opts.chainUnavailable) return "unavailable";
      return { collected: true, capturable: "1000", refundable: "0" };
    },
    async getPaymentInfoHash() {
      return opts.tradeId.toLowerCase();
    },
    async getEscrowCall(txHash) {
      if (opts.chainUnavailable || opts.escrowCallUnavailable) return "unavailable";
      if (opts.txMissing || !isKnownPaymentTx(txHash)) return "not_found";
      if (opts.txReverted) return "rejected";
      return {
        from: opts.info.operator.toLowerCase(),
        selector: AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase(),
        input: authorizeCalldata(opts.info),
      };
    },
    async getTxFacts(txHash) {
      if (opts.chainUnavailable) return "unavailable";
      if (opts.txMissing || !isKnownPaymentTx(txHash)) return "not_found";
      return {
        from: opts.info.operator.toLowerCase(),
        to: ESCROW.toLowerCase(),
        status: opts.txReverted && txHash.toLowerCase() === paymentTx ? "reverted" : "success",
        input: authorizeCalldata(opts.info),
      };
    },
    async getLatestBlockTimestamp() {
      return Math.floor(Date.now() / 1000);
    },
    async getLatestBlockNumber() {
      bumpChainReads();
      trace.latestBlockReads++;
      if (opts.chainUnavailable) return "unavailable";
      return block;
    },
    async readAuthorizeAtBlock(txHash, _escrow, bn) {
      bumpChainReads();
      trace.authorizeBlocks.push(bn);
      if (opts.chainUnavailable) return "unavailable";
      if (opts.txMissing || !isKnownPaymentTx(txHash)) return "not_found";
      if (!authorizeTxVisibleAtBlock(BigInt(txBlock), bn)) return "not_found";
      if (opts.txReverted) {
        const decoded = decodeAuthorizePaymentInfo(authorizeCalldata(opts.info));
        return {
          hash: txHash.toLowerCase(),
          blockNumber: txBlock,
          blockTimestamp: Math.floor(Date.now() / 1000),
          status: "reverted",
          input: authorizeCalldata(opts.info),
          paymentInfo: decoded,
        };
      }
      const decoded = decodeAuthorizePaymentInfo(authorizeCalldata(opts.info));
      return {
        hash: txHash.toLowerCase(),
        blockNumber: txBlock,
        blockTimestamp: Math.floor(Date.now() / 1000),
        status: "success",
        input: authorizeCalldata(opts.info),
        paymentInfo: decoded,
      };
    },
    async paymentTxPaysTo() {
      return true;
    },
  };
  return { reader, trace, paymentTx };
}

function allLegRows(store: ReturnType<typeof memoryTradeDisputeStore>): TradeDisputeLegRow[] {
  const out: TradeDisputeLegRow[] = [];
  for (const list of store.rows.values()) out.push(...list);
  return out;
}

async function signPayerSubmit(
  store: TradeDisputeStore,
  input: {
    info: AuthCapturePaymentInfoTuple;
    paymentTx?: string;
    delivery?: "none" | "received";
    receivedBody?: string | null;
    sellerReceipt?: boolean;
    issued?: string;
    signature?: string;
    payer?: typeof PAYER;
  },
) {
  const tradeId = tradeIdFor(input.info);
  const paymentTx = (input.paymentTx ?? "0x" + "a".repeat(64)).toLowerCase();
  const delivery = input.delivery ?? "none";
  const receivedBodySha256 =
    delivery === "received" && input.receivedBody ? bodySha(input.receivedBody) : null;
  const issued = input.issued ?? issuedNow();
  const message = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery,
    receivedBodySha256,
    issued,
  });
  const payerAccount = input.payer ?? PAYER;
  const signature = input.signature ?? (await payerAccount.signMessage({ message }));
  const body: Record<string, unknown> = {
    action: "submit",
    side: "payer",
    tradeId,
    chain: TRADE_DISPUTE_CHAIN,
    paymentTx,
    delivery,
    receivedBodySha256: delivery === "received" && receivedBodySha256 ? receivedBodySha256 : "none",
    issued,
    signature,
  };
  if (input.sellerReceipt && receivedBodySha256) {
    const rIssued = issuedNow();
    const rMsg = tradeDisputeDeliveryReceiptMessage({
      tradeId,
      bodySha256: receivedBodySha256,
      issued: rIssued,
    });
    const rSig = await SELLER.signMessage({ message: rMsg });
    body.sellerReceipt = { signature: rSig, issued: rIssued };
  }
  return submitTradeDisputeLeg(body, store);
}

async function signSellerSubmit(
  store: TradeDisputeStore,
  input: {
    info: AuthCapturePaymentInfoTuple;
    paymentTx?: string;
    paymentSeen?: "yes" | "no";
    delivery?: "none" | "delivered";
    deliveredBody?: string | null;
    issued?: string;
    signature?: string;
    signer?: typeof SELLER;
  },
) {
  const tradeId = tradeIdFor(input.info);
  const paymentSeen = input.paymentSeen ?? "yes";
  const delivery = input.delivery ?? "none";
  const paymentTx = (input.paymentTx ?? "0x" + "a".repeat(64)).toLowerCase();
  const deliveredBodySha256 =
    delivery === "delivered" && input.deliveredBody ? bodySha(input.deliveredBody) : null;
  const issued = input.issued ?? issuedNow();
  const message = tradeDisputeLegSignMessage({
    tradeId,
    side: "seller",
    paymentTx,
    paymentSeen,
    delivery,
    deliveredBodySha256,
    issued,
  });
  const signer = input.signer ?? SELLER;
  const signature = input.signature ?? (await signer.signMessage({ message }));
  return submitTradeDisputeLeg(
    {
      action: "submit",
      side: "seller",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      paymentSeen,
      delivery,
      deliveredBodySha256: delivery === "delivered" && deliveredBodySha256 ? deliveredBodySha256 : "none",
      issued,
      signature,
    },
    store,
  );
}

function quotedStringsFromSource(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/"([^"\\]|\\.)*"/g)) {
    out.push(m[0].slice(1, -1));
  }
  return out;
}

function collectStrings(value: unknown, skipTopKey?: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (skipTopKey && k === skipTopKey) continue;
      out.push(...collectStrings(v));
    }
    return out;
  }
  return [];
}

let store: ReturnType<typeof memoryTradeDisputeStore>;

before(() => {
  store = memoryTradeDisputeStore();
  setTradeDisputeStoreForTests(store);
});

afterEach(() => {
  store = memoryTradeDisputeStore();
  setTradeDisputeStoreForTests(store);
  setE6ChainReaderForTests(null);
  resetTradeDisputeWriteLimitsForTests();
});

after(() => {
  setTradeDisputeStoreForTests(null);
  setE6ChainReaderForTests(null);
});

test("[p2d] T9 public surfaces omit fault vocabulary outside claims", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  assert.equal((await signPayerSubmit(store, { info, paymentTx, delivery: "received", receivedBody: "x" })).ok, true);
  assert.equal(
    (await signSellerSubmit(store, { info, paymentTx, delivery: "delivered", deliveredBody: "x" })).ok,
    true,
  );

  const json = await publicJsonForTrade(store, tradeId);
  assert.ok(json);

  const { GET: getTrade } = await import("@/app/api/v1/observatory/disputes/route");
  const routeRes = await getTrade(new NextRequest(`http://x/api/v1/observatory/disputes?tradeId=${tradeId}`));
  const routeJson = await routeRes.json();

  const day = new Date().toISOString().slice(0, 10);
  const { GET: getDay } = await import("@/app/api/v1/observatory/disputes/day/route");
  const dayRes = await getDay(new NextRequest(`http://x/api/v1/observatory/disputes/day?day=${day}`));

  const connectStrings = quotedStringsFromSource(readFileSync("src/app/connect/trade-dispute/page.tsx", "utf8"));
  const panelStrings = quotedStringsFromSource(readFileSync("src/components/connect/TradeDisputePanel.tsx", "utf8"));
  const docsApi = apiDocsPageText()
    .split("\n")
    .filter((l) => l.includes("observatory/disputes"))
    .join("\n");
  const openapi = readFileSync("docs/openapi.yaml", "utf8")
    .split("\n")
    .filter((l) => /observatory\/disputes|getTradeDispute|submitTradeDisputeLeg|getTradeDisputeDay/i.test(l))
    .join("\n");
  const panelRows = tradeDisputeDisplayRows(json);

  const blobs = [
    JSON.stringify(routeJson),
  ]
    .concat(collectStrings(routeJson, "claims"))
    .concat(collectStrings(dayRes.status === 200 ? await dayRes.json() : {}))
    .concat(panelRows.map((r) => `${r.label} ${r.value}`))
    .concat(connectStrings)
    .concat(panelStrings)
    .concat(quotedStringsFromSource(docsApi))
    .concat([openapi, json.note, P2_CLAIMS_NOTE]);

  for (const text of blobs) {
    assert.doesNotMatch(text, FORBIDDEN_PUBLIC_ENGLISH, `forbidden english in ${text.slice(0, 80)}`);
    assert.doesNotMatch(text, FORBIDDEN_VERDICT_WORDS, `verdict word in ${text.slice(0, 80)}`);
  }

  for (const side of ["payer", "seller"] as const) {
    const cur = json.claims[side].current;
    if (cur) {
      assert.ok(["none", "received", "delivered"].includes(cur.delivery));
      if (cur.paymentSeen) assert.ok(cur.paymentSeen === "yes" || cur.paymentSeen === "no");
    }
  }

  const oneSided = memoryTradeDisputeStore();
  setTradeDisputeStoreForTests(oneSided);
  assert.equal((await signPayerSubmit(oneSided, { info, paymentTx, delivery: "none" })).ok, true);
  const partial = await publicJsonForTrade(oneSided, tradeId);
  assert.ok(partial);
  assert.equal(partial.chainFacts.status, "matched");
});

test("[p2d] T10 non-party writes and per-wallet limits", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);

  const rogueMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued: issuedNow(),
  });
  const rogueSig = await ROGUE.signMessage({ message: rogueMsg });
  const rogueRes = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued: issuedNow(),
      signature: rogueSig,
    },
    store,
  );
  assert.equal(rogueRes.ok, false);
  assert.ok([400, 422].includes(rogueRes.status));
  assert.equal(allLegRows(store).length, 0);

  const badTxRes = await signPayerSubmit(store, {
    info,
    paymentTx: "0x" + "b".repeat(64),
    delivery: "none",
  });
  assert.equal(badTxRes.ok, false);
  assert.equal(badTxRes.reason, "payment_tx_not_found");

  setTradeDisputeWriteLimitsForTests(1, 10);
  assert.equal((await signPayerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);
  const limited = await signPayerSubmit(store, { info, paymentTx, delivery: "received", receivedBody: "a" });
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, "write_limit_reached");

  const otherStore = memoryTradeDisputeStore();
  const info2 = defaultPaymentInfo(43n);
  const tradeId2 = tradeIdFor(info2);
  const reader2 = mockChainReader({ tradeId: tradeId2, info: info2, paymentTx: "0x" + "c".repeat(64) });
  setE6ChainReaderForTests(reader2.reader);
  assert.equal(
    (await signSellerSubmit(otherStore, {
      info: info2,
      paymentTx: "0x" + "c".repeat(64),
      delivery: "none",
    })).ok,
    true,
  );
});

test("[p2d] T10d no global write cap across many trades", async () => {
  setTradeDisputeWriteLimitsForTests(25, 25);
  const oneStore = memoryTradeDisputeStore();
  setTradeDisputeStoreForTests(oneStore);
  for (let i = 0; i < 25; i++) {
    const payer = walletForIndex(i * 2);
    const seller = walletForIndex(i * 2 + 1);
    const info = defaultPaymentInfo(BigInt(100 + i), {
      payer: payer.address,
      receiver: seller.address,
      operator: seller.address,
    });
    const tradeId = tradeIdFor(info);
    const payTx = `0x${(i + 1).toString(16).padStart(64, "0")}`;
    setE6ChainReaderForTests(mockChainReader({ tradeId, info, paymentTx: payTx }).reader);
    for (let n = 0; n < 20; n++) {
      const res = await signPayerSubmit(oneStore, { info, paymentTx: payTx, delivery: "none", payer });
      assert.equal(res.ok, true, `trade ${i} write ${n}`);
    }
  }
  assert.equal(allLegRows(oneStore).length, 500);
});

test("[p2d] real escrow shape: payer signs, tx.from operator key cannot write payer side", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  assert.equal((await signPayerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);

  const operatorMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued: issuedNow(),
  });
  const operatorSig = await SELLER.signMessage({ message: operatorMsg });
  const operatorPayer = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued: issuedNow(),
      signature: operatorSig,
    },
    store,
  );
  assert.equal(operatorPayer.ok, false);
  assert.ok([400, 422].includes(operatorPayer.status));
  assert.equal(allLegRows(store).length, 1);

  const thirdPartyOperator = ROGUE;
  const thirdInfo = defaultPaymentInfo(555n, {
    operator: thirdPartyOperator.address,
    payer: PAYER.address,
    receiver: SELLER.address,
  });
  const thirdId = tradeIdFor(thirdInfo);
  const thirdTx = "0x" + "f1".repeat(32);
  setE6ChainReaderForTests(mockChainReader({ tradeId: thirdId, info: thirdInfo, paymentTx: thirdTx }).reader);
  assert.equal((await signPayerSubmit(store, { info: thirdInfo, paymentTx: thirdTx, delivery: "none" })).ok, true);
  const sellerMsg = tradeDisputeLegSignMessage({
    tradeId: thirdId,
    side: "seller",
    paymentTx: thirdTx,
    paymentSeen: "yes",
    delivery: "none",
    deliveredBodySha256: null,
    issued: issuedNow(),
  });
  const opSeller = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "seller",
      tradeId: thirdId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx: thirdTx,
      paymentSeen: "yes",
      delivery: "none",
      deliveredBodySha256: "none",
      issued: issuedNow(),
      signature: await thirdPartyOperator.signMessage({ message: sellerMsg }),
    },
    store,
  );
  assert.equal(opSeller.ok, false);
  assert.ok([400, 422].includes(opSeller.status));
});

test("[p2d] payment_tx_not_found when authorize tx is missing on chain", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info, txMissing: true }).reader);
  const res = await signPayerSubmit(store, { info, delivery: "none" });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "payment_tx_not_found");
    assert.equal(res.status, 422);
  }
  assert.equal(allLegRows(store).length, 0);
});

test("[p2d] T11 claim updates and history limits", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);

  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "delivered", deliveredBody: "b" })).ok, true);

  const json = await publicJsonForTrade(store, tradeId);
  assert.ok(json);
  assert.equal(json.claims.seller.current?.delivery, "delivered");
  assert.equal(json.claims.seller.history.length, 1);
  assert.equal(json.claims.seller.history[0]?.delivery, "none");

  const staleIssued = new Date(Date.parse(json.claims.seller.current!.issued) - 60_000).toISOString();
  const stale = await signSellerSubmit(store, {
    info,
    paymentTx,
    delivery: "none",
    issued: staleIssued,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_claim");

  const currentIssued = json.claims.seller.current!.issued;
  const dupMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "seller",
    paymentTx,
    paymentSeen: "yes",
    delivery: "delivered",
    deliveredBodySha256: bodySha("b"),
    issued: currentIssued,
  });
  const dupSig = await SELLER.signMessage({ message: dupMsg });
  const dupBody = {
    action: "submit",
    side: "seller",
    tradeId,
    chain: TRADE_DISPUTE_CHAIN,
    paymentTx,
    paymentSeen: "yes",
    delivery: "delivered",
    deliveredBodySha256: bodySha("b"),
    issued: currentIssued,
    signature: dupSig,
  };
  const dup = await submitTradeDisputeLeg(dupBody, store);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "already_recorded");

  setTradeDisputeWriteLimitsForTests(20, 2);
  const sideStore = memoryTradeDisputeStore();
  setTradeDisputeStoreForTests(sideStore);
  assert.equal((await signSellerSubmit(sideStore, { info, paymentTx, delivery: "none" })).ok, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await signSellerSubmit(sideStore, { info, paymentTx, delivery: "delivered", deliveredBody: "c" })).ok, true);
  await new Promise((r) => setTimeout(r, 5));
  const histLimit = await signSellerSubmit(sideStore, { info, paymentTx, delivery: "delivered", deliveredBody: "d" });
  assert.equal(histLimit.ok, false);
  assert.equal(histLimit.reason, "write_limit_reached");
});

test("[p2d] T12 known authorize fixture hash", async () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/auth-capture-known-authorize-84532.json", "utf8"),
  ) as {
    input: string;
    chainId: number;
    escrow: string;
    getHashAtBlock: string;
    paymentAuthorizedEventTopic1: string;
    paymentInfo: { payer: string; salt: string };
  };
  const decoded = decodeAuthorizePaymentInfo(fixture.input);
  assert.ok(decoded);
  const payer = (decoded as { payer: string }).payer.toLowerCase();
  const hash = hashPaymentInfo(fixture.chainId, decoded as never, payer, fixture.escrow);
  assert.equal(hash, fixture.getHashAtBlock.toLowerCase());
  assert.equal(hash, fixture.paymentAuthorizedEventTopic1.toLowerCase());

  const mutated = {
    ...(decoded as object),
    salt: BigInt(fixture.paymentInfo.salt) + 1n,
  };
  const bad = hashPaymentInfo(fixture.chainId, mutated as never, payer, fixture.escrow);
  assert.notEqual(bad, fixture.getHashAtBlock.toLowerCase());

  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  assert.equal((await signPayerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);

  const wrongTradeId = tradeId.slice(0, -1) + (tradeId.slice(-1) === "a" ? "b" : "a");
  const reject = await signPayerSubmit(store, {
    info,
    paymentTx,
    delivery: "none",
  });
  const rejectBody = {
    action: "submit",
    side: "payer",
    tradeId: wrongTradeId,
    chain: TRADE_DISPUTE_CHAIN,
    paymentTx,
    delivery: "none",
    receivedBodySha256: "none",
    issued: issuedNow(),
    signature: (await PAYER.signMessage({
      message: tradeDisputeLegSignMessage({
        tradeId: wrongTradeId,
        side: "payer",
        paymentTx,
        delivery: "none",
        receivedBodySha256: null,
        issued: issuedNow(),
      }),
    })),
  };
  const badParty = await submitTradeDisputeLeg(rejectBody, store);
  assert.equal(badParty.ok, false);
  assert.equal(badParty.reason, "not_a_party");
  void reject;
});

test("[p2d] T13 chain facts pin readAtBlock", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const block = 9_999_001;
  const { reader, trace, paymentTx } = mockChainReader({ tradeId, info, blockNumber: block });
  setE6ChainReaderForTests(reader);
  assert.equal((await signPayerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);
  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);

  const json = await publicJsonForTrade(store, tradeId);
  assert.ok(json);
  assert.equal(json.chainFacts.readAtBlock, String(block));
  assert.ok(trace.authorizeBlocks.every((b) => b === block));
  assert.ok(trace.stateBlocks.every((b) => b === block));

  const unavail = mockChainReader({ tradeId, info, chainUnavailable: true });
  setE6ChainReaderForTests(unavail.reader);
  const down = await publicJsonForTrade(store, tradeId);
  assert.equal(down?.chainFacts.status, "unavailable");
  assert.equal(down?.chainFacts.readAtBlock, null);

  const missing = mockChainReader({ tradeId, info, txMissing: true });
  setE6ChainReaderForTests(missing.reader);
  const noTx = await publicJsonForTrade(store, tradeId);
  assert.equal(noTx?.chainFacts.status, "unmatched");

  const pinned = 58_290_000;
  const txIncluded = 5_828_2443;
  const early = mockChainReader({ tradeId, info, blockNumber: pinned, txBlockNumber: txIncluded });
  setE6ChainReaderForTests(early.reader);
  const earlyStore = memoryTradeDisputeStore();
  setTradeDisputeStoreForTests(earlyStore);
  assert.equal((await signPayerSubmit(earlyStore, { info, paymentTx: early.paymentTx, delivery: "none" })).ok, true);
  assert.equal((await signSellerSubmit(earlyStore, { info, paymentTx: early.paymentTx, delivery: "none" })).ok, true);
  const matched = await publicJsonForTrade(earlyStore, tradeId);
  assert.equal(matched?.chainFacts.status, "matched");
  assert.equal(matched?.chainFacts.readAtBlock, String(pinned));
  assert.equal(matched?.chainFacts.authorizeTx?.blockNumber, txIncluded);

  const futureTx = mockChainReader({ tradeId, info, blockNumber: pinned, txBlockNumber: pinned + 1 });
  setE6ChainReaderForTests(futureTx.reader);
  const futureJson = await publicJsonForTrade(earlyStore, tradeId);
  assert.equal(futureJson?.chainFacts.status, "unmatched");
});

test("[p2d] authorizeTxVisibleAtBlock pins visibility at block N", () => {
  assert.equal(authorizeTxVisibleAtBlock(null, 100), false);
  assert.equal(authorizeTxVisibleAtBlock(99n, 100), true);
  assert.equal(authorizeTxVisibleAtBlock(100n, 100), true);
  assert.equal(authorizeTxVisibleAtBlock(101n, 100), false);
});

test("[p2d] ops counts bilateral current claims only", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const payTx = "0x" + "d".repeat(64);
  const base = {
    chain: TRADE_DISPUTE_CHAIN,
    payer: PAYER.address.toLowerCase(),
    receiver: SELLER.address.toLowerCase(),
    paymentInfoOperator: SELLER.address.toLowerCase(),
    signer: PAYER.address.toLowerCase(),
    paymentTx: payTx,
    commitment: "e".repeat(64),
    issued: issuedNow(),
    acceptedAt: "2026-06-01T12:00:00.000Z",
  };
  const payerOnly: TradeDisputeLegRow[] = [
    {
      ...base,
      tradeId,
      side: "payer",
      delivery: "none",
      receivedBodySha256: null,
      paymentSeen: null,
      deliveredBodySha256: null,
      sellerReceiptCommitment: null,
      sellerReceiptSignature: null,
      sellerReceiptIssued: null,
    },
  ];
  assert.equal(await countPublicTradeDisputes(payerOnly), 0);

  const both: TradeDisputeLegRow[] = [
    ...payerOnly,
    {
      ...base,
      tradeId,
      side: "seller",
      signer: SELLER.address.toLowerCase(),
      delivery: "none",
      receivedBodySha256: null,
      paymentSeen: "yes",
      deliveredBodySha256: null,
      sellerReceiptCommitment: null,
      sellerReceiptSignature: null,
      sellerReceiptIssued: null,
    },
  ];
  assert.equal(await countPublicTradeDisputes(both), 1);

  const sellerCard = buildSellerCard({
    wallet: SELLER.address,
    revenue: {
      measurementSettledCount: 0,
      measurementSettledUnitsSum: "0",
      reportedVerifiedCount: 0,
      reportedVerifiedUnitsSum: "0",
    },
    l1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    disputes: { purchaseIdsChecked: 0, truncated: false, recordsPresent: 1, disputeCount: 1, p2Live: true },
    reputation: { pass: 0, fail: 0, withdrawn: 0, unverified: 0 },
  });
  assert.equal(sellerCard.disputes.disputeCount, 1);
});

test("[p2d] sellerReceipt verified only with valid signature", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  assert.equal(
    (await signPayerSubmit(store, { info, paymentTx, delivery: "received", receivedBody: "body", sellerReceipt: true }))
      .ok,
    true,
  );
  const json = await publicJsonForTrade(store, tradeId);
  assert.equal(json?.claims.payer.current?.sellerReceipt?.verified, true);
});

test("[p2d] GET disputes/day matches recompute", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info }).reader);
  assert.equal((await signPayerSubmit(store, { info, delivery: "none" })).ok, true);
  const day = new Date().toISOString().slice(0, 10);
  const legs = allLegRows(store);
  const commitments = commitmentsForUtcDay(
    day,
    legs.map((l) => ({ commitment: l.commitment, acceptedAt: l.acceptedAt })),
  );
  const payload = tradeDisputeDayPayload(day, commitments);
  const rootHash = tradeDisputeDayRootHash(null, day, commitments);
  const { GET } = await import("@/app/api/v1/observatory/disputes/day/route");
  const res = await GET(new NextRequest(`http://x/api/v1/observatory/disputes/day?day=${day}`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rootHash: string; payload: string };
  assert.equal(body.rootHash, rootHash);
});

test("[p2d] view returns 403 unverified uniformly", async () => {
  const { POST } = await import("@/app/api/v1/observatory/disputes/trade/route");
  const res = await POST(
    new NextRequest("http://x/api/v1/observatory/disputes/trade", {
      method: "POST",
      body: JSON.stringify({
        action: "view",
        tradeId: "0x" + "1".repeat(64),
        party: "payer",
        proof: {
          kind: "payto_signature",
          wallet: PAYER.address,
          issued: new Date().toISOString(),
          signature: "0x" + "2".repeat(130),
        },
      }),
    }),
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "unverified");
});

const MAX_U120 = 2n ** 120n;
const UINT256_MAX = (2n ** 256n - 1n).toString(10);
const UINT256_TOO_LONG = "1" + UINT256_MAX;
const UINT48_MAX = (2n ** 48n - 1n).toString(10);
const UINT48_TOO_LONG = "1" + UINT48_MAX;

function legacyP2cPayerSignMessage(input: {
  tradeId: string;
  paymentTx: string;
  issued: string;
}): string {
  return [
    `${SIGNING_DOMAIN} trade dispute leg`,
    `domain: ${SIGNING_DOMAIN}`,
    `trade_id: ${input.tradeId.toLowerCase()}`,
    `chain: ${TRADE_DISPUTE_CHAIN}`,
    "side: payer",
    `payment_tx: ${input.paymentTx.toLowerCase()}`,
    "received_body_sha256: none",
    "state: received",
    `issued: ${input.issued}`,
    "This signature does not move funds.",
  ].join("\n");
}

test("[p2d] forged seller and payer signatures return 400 invalid_signature", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  const issued = issuedNow();
  const sellerMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "seller",
    paymentTx,
    paymentSeen: "yes",
    delivery: "none",
    deliveredBodySha256: null,
    issued,
  });
  const badSeller = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "seller",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      paymentSeen: "yes",
      delivery: "none",
      deliveredBodySha256: "none",
      issued,
      signature: await ROGUE.signMessage({ message: sellerMsg }),
    },
    store,
  );
  assert.equal(badSeller.ok, false);
  if (!badSeller.ok) assert.equal(badSeller.reason, "invalid_signature");
  assert.equal(allLegRows(store).length, 0);

  const payerMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued,
  });
  const badPayer = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued,
      signature: await ROGUE.signMessage({ message: payerMsg }),
    },
    store,
  );
  assert.equal(badPayer.ok, false);
  if (!badPayer.ok) assert.equal(badPayer.reason, "invalid_signature");
});

test("[p2d] non-ISO issued and signature_expired on submit", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  const notIso = "2026-08-22T12:00:00Z";
  const payerMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued: notIso,
  });
  const badIso = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued: notIso,
      signature: await PAYER.signMessage({ message: payerMsg }),
    },
    store,
  );
  assert.equal(badIso.ok, false);
  if (!badIso.ok) assert.equal(badIso.reason, "invalid_signature");

  const expiredIssued = new Date(Date.now() - 11 * 60_000).toISOString();
  const expiredMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued: expiredIssued,
  });
  const expired = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued: expiredIssued,
      signature: await PAYER.signMessage({ message: expiredMsg }),
    },
    store,
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "signature_expired");
});

test("[p2d] signature_expired on view", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info }).reader);
  await signPayerSubmit(store, { info, delivery: "none" });
  const issued = new Date(Date.now() - 11 * 60_000).toISOString();
  const sig = await PAYER.signMessage({ message: p2PartyAccessMessage({ tradeId, party: "payer", issued }) });
  const { POST } = await import("@/app/api/v1/observatory/disputes/trade/route");
  const res = await POST(
    new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "view",
        tradeId,
        party: "payer",
        proof: { kind: "payto_signature", wallet: PAYER.address, signature: sig, issued },
      }),
    }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "signature_expired");
});

test("[p2d] legacy p2c leg sign message is rejected", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  const issued = issuedNow();
  const legacy = legacyP2cPayerSignMessage({ tradeId, paymentTx, issued });
  const res = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued,
      signature: await PAYER.signMessage({ message: legacy }),
    },
    store,
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "invalid_signature");
});

test("[p2d] POST trade rejects null array body and 16 KiB overflow", async () => {
  const { POST } = await import("@/app/api/v1/observatory/disputes/trade/route");
  for (const body of ["null", "[]", "not-json"]) {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === "not-json" ? "{" : body,
      }),
    );
    assert.equal(res.status, 400);
  }
  const big = "a".repeat(16_385);
  const huge = await POST(
    new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
      method: "POST",
      body: big,
    }),
  );
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error, "payload_too_large");
});

test("[p2d] chain escrow read unavailable returns 503 without store write", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info, escrowCallUnavailable: true }).reader);
  const res = await signPayerSubmit(store, { info, delivery: "none" });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "chain_unavailable");
    assert.equal(res.status, 503);
  }
  assert.equal(allLegRows(store).length, 0);
});

test("[p2d] rejected submit never appears on GET", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info, txReverted: true }).reader);
  const submit = await signPayerSubmit(store, { info, delivery: "none" });
  assert.equal(submit.ok, false);
  assert.equal(submit.reason, "not_a_party");
  const { GET } = await import("@/app/api/v1/observatory/disputes/route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/observatory/disputes?tradeId=${tradeId}`));
  assert.equal(res.status, 404);
});

test("[p2d] GET disputes re-reads chain each request", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx, trace } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  await signPayerSubmit(store, { info, paymentTx, delivery: "none" });
  await signSellerSubmit(store, { info, paymentTx, delivery: "none" });
  const { GET } = await import("@/app/api/v1/observatory/disputes/route");
  const url = `http://localhost/api/v1/observatory/disputes?tradeId=${tradeId}`;
  const before = trace.chainFactReads;
  await GET(new NextRequest(url));
  const afterOne = trace.chainFactReads;
  await GET(new NextRequest(url));
  const afterTwo = trace.chainFactReads;
  const perGet = afterOne - before;
  assert.ok(perGet > 0);
  assert.equal(afterTwo - afterOne, perGet);
});

test("[p2d] GET disputes chainFacts change when reader changes between calls", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const base = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(base.reader);
  await signPayerSubmit(store, { info, paymentTx: base.paymentTx, delivery: "none" });
  await signSellerSubmit(store, { info, paymentTx: base.paymentTx, delivery: "none" });
  const { GET } = await import("@/app/api/v1/observatory/disputes/route");
  const url = `http://localhost/api/v1/observatory/disputes?tradeId=${tradeId}`;
  const first = await (await GET(new NextRequest(url))).json();
  assert.equal(first.chainFacts.status, "matched");
  setE6ChainReaderForTests(mockChainReader({ tradeId, info, txMissing: true }).reader);
  const second = await (await GET(new NextRequest(url))).json();
  assert.equal(second.chainFacts.status, "unmatched");
});

test("[p2d] invalid seller receipt and tampered stored receipt", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  const issued = issuedNow();
  const bodyHash = bodySha("rcpt-body");
  const payerMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "received",
    receivedBodySha256: bodyHash,
    issued,
  });
  const badReceipt = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "received",
      receivedBodySha256: bodyHash,
      issued,
      signature: await PAYER.signMessage({ message: payerMsg }),
      sellerReceipt: { signature: "0x" + "f".repeat(130), issued },
    },
    store,
  );
  assert.equal(badReceipt.ok, false);
  if (!badReceipt.ok) assert.equal(badReceipt.reason, "invalid_seller_receipt");

  const noneIssued = issuedNow();
  const noneMsg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued: noneIssued,
  });
  const noneWithReceipt = await submitTradeDisputeLeg(
    {
      action: "submit",
      side: "payer",
      tradeId,
      chain: TRADE_DISPUTE_CHAIN,
      paymentTx,
      delivery: "none",
      receivedBodySha256: "none",
      issued: noneIssued,
      signature: await PAYER.signMessage({ message: noneMsg }),
      sellerReceipt: { signature: "0x" + "a".repeat(130), issued: noneIssued },
    },
    store,
  );
  assert.equal(noneWithReceipt.ok, false);
  if (!noneWithReceipt.ok) assert.equal(noneWithReceipt.reason, "invalid_seller_receipt");

  assert.equal(
    (await signPayerSubmit(store, { info, paymentTx, delivery: "received", receivedBody: "rcpt-body", sellerReceipt: true }))
      .ok,
    true,
  );
  const legs = await store.getLegs(tradeId);
  const row = legs.payer.current!;
  row.sellerReceiptSignature = "0x" + "b".repeat(130);
  const tampered = await publicJsonForTrade(store, tradeId);
  assert.equal(tampered?.claims.payer.current?.sellerReceipt?.verified, false);
});

test("[p2d] view 403 unverified same shape and malformed proof 400", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info }).reader);
  await signPayerSubmit(store, { info, delivery: "none" });
  const { POST } = await import("@/app/api/v1/observatory/disputes/trade/route");
  const rogueIssued = issuedNow();
  const rogueSig = await ROGUE.signMessage({
    message: p2PartyAccessMessage({ tradeId, party: "payer", issued: rogueIssued }),
  });
  const wrongWallet = await POST(
    new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "view",
        tradeId,
        party: "payer",
        proof: { kind: "payto_signature", wallet: ROGUE.address, signature: rogueSig, issued: rogueIssued },
      }),
    }),
  );
  assert.equal(wrongWallet.status, 403);
  const missingTrade = await POST(
    new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "view",
        tradeId: "0x" + "9".repeat(64),
        party: "payer",
        proof: { kind: "payto_signature", wallet: PAYER.address, signature: rogueSig, issued: rogueIssued },
      }),
    }),
  );
  assert.equal(missingTrade.status, 403);
  assert.equal((await missingTrade.json()).error, "unverified");
  assert.equal((await wrongWallet.json()).error, "unverified");
  for (const proof of [undefined, null, {}, { kind: 1 }]) {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          proof === undefined
            ? { action: "view", tradeId, party: "payer" }
            : { action: "view", tradeId, party: "payer", proof },
        ),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_request");
  }
});

test("[p2d] view rate limit 11th request returns 429", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info }).reader);
  await signPayerSubmit(store, { info, delivery: "none" });
  const { POST } = await import("@/app/api/v1/observatory/disputes/trade/route");
  const issued = issuedNow();
  const sig = await PAYER.signMessage({ message: p2PartyAccessMessage({ tradeId, party: "payer", issued }) });
  const payload = {
    action: "view",
    tradeId,
    party: "payer",
    proof: { kind: "payto_signature", wallet: PAYER.address, signature: sig, issued },
  };
  const ipHeader = { "x-forwarded-for": "203.0.113.77" };
  for (let i = 0; i < 10; i++) {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
        method: "POST",
        headers: { ...ipHeader, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    assert.notEqual(res.status, 429, `call ${i + 1}`);
  }
  const limited = await POST(
    new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
      method: "POST",
      headers: { ...ipHeader, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
});

test("[p2d] store null and simulated 42P01 return 503 disputes_unavailable", async () => {
  setTradeDisputeStoreForTests(null);
  const { POST } = await import("@/app/api/v1/observatory/disputes/trade/route");
  const postRes = await POST(
    new NextRequest("http://localhost/api/v1/observatory/disputes/trade", {
      method: "POST",
      body: JSON.stringify({ action: "submit" }),
    }),
  );
  assert.equal(postRes.status, 503);
  assert.equal((await postRes.json()).error, "disputes_unavailable");

  const throwing = memoryTradeDisputeStore();
  throwing.getLegs = async () => {
    throw Object.assign(new Error("disputes_unavailable"), { code: "disputes_unavailable" });
  };
  setTradeDisputeStoreForTests(throwing);
  const { GET } = await import("@/app/api/v1/observatory/disputes/route");
  const getRes = await GET(
    new NextRequest(`http://localhost/api/v1/observatory/disputes?tradeId=${"0x" + "b".repeat(64)}`),
  );
  assert.equal(getRes.status, 503);
});

test("[p2d] GET disputes/day 503 on unexpected store error", async () => {
  const throwing = memoryTradeDisputeStore();
  throwing.listLegsForUtcDay = async () => {
    throw Object.assign(new Error("disputes_unavailable"), { code: "disputes_unavailable" });
  };
  setTradeDisputeStoreForTests(throwing);
  const { GET } = await import("@/app/api/v1/observatory/disputes/day/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/disputes/day?day=2026-06-01"));
  assert.equal(res.status, 503);
});

test("[p2d] daily root seal and conflict frozen", async () => {
  const info = defaultPaymentInfo();
  setE6ChainReaderForTests(mockChainReader({ tradeId: tradeIdFor(info), info }).reader);
  await signPayerSubmit(store, { info, delivery: "none" });
  const day = new Date().toISOString().slice(0, 10);
  const first = await store.sealDay(day);
  assert.equal(first.status, "sealed");
  const savedPayload = (await store.getDaySeal(day))?.payload;
  assert.ok(savedPayload);
  assert.equal((await store.sealDay(day)).status, "unchanged");
  await signSellerSubmit(store, { info, delivery: "none" });
  const frozen = await store.sealDay(day);
  assert.equal(frozen.status, "conflict_frozen");
  assert.equal((await store.getDaySeal(day))?.payload, savedPayload);
});

test("[p2d] metrics rollup isolates E6 seal and keeps L1 anchor", () => {
  const src = readFileSync("src/app/api/cron/metrics-rollup/route.ts", "utf8");
  assert.match(src, /sealTradeDisputeDay/);
  assert.match(src, /cron\.metrics-rollup\.e6-anchor/);
  const anchorIdx = src.indexOf("anchorThrough");
  const e6Idx = src.indexOf("sealTradeDisputeDay");
  assert.ok(anchorIdx > 0 && e6Idx > anchorIdx);
});

test("[p2d] metrics rollup keeps L1 anchor when E6 seal throws", async () => {
  const { setMetricsRollupE6DepsForTests, GET } = await import("@/app/api/cron/metrics-rollup/route");
  const anchorDay = { status: "unchanged" as const, day: "2026-01-01", rootHash: "abc", entryCount: 0 };
  setMetricsRollupE6DepsForTests({
    metricsRollupCronRollups: async () => ({ lookbackDays: 14, days: [], driftDaysRecomputed: [] }),
    anchorThrough: async () => [anchorDay],
    sealTradeDisputeDay: async () => {
      throw new Error("e6 blew up");
    },
  });
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  try {
    const res = await GET(
      new NextRequest("http://localhost/api/cron/metrics-rollup", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.anchor, anchorDay);
  } finally {
    setMetricsRollupE6DepsForTests(null);
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test("[p2d] hashPaymentInfo matches SDK", () => {
  const info = defaultPaymentInfo();
  const app = hashPaymentInfo(CHAIN_ID, info, PAYER.address, ESCROW);
  const sdkInfo = {
    ...info,
    maxAmount: String(info.maxAmount),
    salt: String(info.salt),
  };
  const sdk = sdkHashPaymentInfo(CHAIN_ID, sdkInfo, PAYER.address, ESCROW).toLowerCase();
  assert.equal(app, sdk);
});

test("[p2d] leg commitment is sha256 of message and signature", () => {
  const message = "hello";
  const sig = "0x" + "a".repeat(130);
  const expected = createHash("sha256")
    .update(message, "utf8")
    .update("\n")
    .update(sig.toLowerCase(), "utf8")
    .digest("hex");
  assert.equal(legCommitment(message, sig), expected);
});

test("[p2d] M1 collector address matches SDK", async () => {
  assert.equal(
    AUTH_CAPTURE_EIP3009_COLLECTOR_V1_1.toLowerCase(),
    "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88".toLowerCase(),
  );
});

test("[p2d] parseAuthCapturePaymentInfo digit bounds", () => {
  const ok = defaultPaymentInfo();
  assert.ok(parseAuthCapturePaymentInfo({ ...ok, maxAmount: String(ok.maxAmount), salt: String(ok.salt) }));
  const maxU120 = (MAX_U120 - 1n).toString(10);
  assert.ok(parseAuthCapturePaymentInfo({ ...ok, maxAmount: maxU120, salt: String(ok.salt) }));
  assert.equal(parseAuthCapturePaymentInfo({ ...ok, maxAmount: MAX_U120.toString(10), salt: String(ok.salt) }), null);
  const saltMax = parseAuthCapturePaymentInfo({ ...ok, maxAmount: String(ok.maxAmount), salt: UINT256_MAX });
  assert.ok(saltMax);
  assert.equal(parseAuthCapturePaymentInfo({ ...ok, maxAmount: String(ok.maxAmount), salt: UINT256_TOO_LONG }), null);
  const expiryOk = parseAuthCapturePaymentInfo({
    ...ok,
    maxAmount: String(ok.maxAmount),
    salt: String(ok.salt),
    preApprovalExpiry: UINT48_MAX,
  });
  assert.ok(expiryOk);
  assert.equal(
    parseAuthCapturePaymentInfo({
      ...ok,
      maxAmount: String(ok.maxAmount),
      salt: String(ok.salt),
      preApprovalExpiry: UINT48_TOO_LONG,
    }),
    null,
  );
});

test("[p2d] docs P2 routes start with Draft and page path matches route", () => {
  const docs = apiDocsPageText();
  const matches = [...docs.matchAll(/path: "\/api\/v1\/observatory\/disputes[^"]*"[\s\S]*?note: "(Draft\.[^"]+)"/g)];
  assert.equal(matches.length, 3);
  assert.equal(P2_DISPUTE_PAGE_PATH, "/connect/trade-dispute");
  const page = readFileSync("src/app/connect/trade-dispute/page.tsx", "utf8");
  assert.match(page, /path:\s*P2_DISPUTE_PAGE_PATH/);
});

test("[p2d] write limit per wallet returns 429", async () => {
  setTradeDisputeWriteLimitsForTests(2, 10);
  const info = defaultPaymentInfo();
  for (let salt = 2000n; salt < 2002n; salt++) {
    const row = { ...info, salt };
    const tradeId = tradeIdFor(row);
    const paymentTx = `0x${salt.toString(16).padStart(64, "0")}`;
    setE6ChainReaderForTests(mockChainReader({ tradeId, info: row, paymentTx }).reader);
    assert.equal((await signSellerSubmit(store, { info: row, paymentTx })).ok, true, String(salt));
  }
  const blockedInfo = { ...info, salt: 2010n };
  const blockedTx = `0x${(2010n).toString(16).padStart(64, "0")}`;
  setE6ChainReaderForTests(
    mockChainReader({ tradeId: tradeIdFor(blockedInfo), info: blockedInfo, paymentTx: blockedTx }).reader,
  );
  const blocked = await signSellerSubmit(store, { info: blockedInfo, paymentTx: blockedTx });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "write_limit_reached");
});

test("[p2d] trade side history cap does not block other trades", async () => {
  setTradeDisputeWriteLimitsForTests(50, 2);
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "delivered", deliveredBody: "b" })).ok, true);
  await new Promise((r) => setTimeout(r, 5));
  const capped = await signSellerSubmit(store, { info, paymentTx, delivery: "delivered", deliveredBody: "c" });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, "write_limit_reached");

  const other = defaultPaymentInfo(77n);
  const otherId = tradeIdFor(other);
  const otherTx = "0x" + "e".repeat(64);
  setE6ChainReaderForTests(mockChainReader({ tradeId: otherId, info: other, paymentTx: otherTx }).reader);
  assert.equal((await signPayerSubmit(store, { info: other, paymentTx: otherTx, delivery: "none" })).ok, true);
});

test("[p2d] GET shows matched reverted authorize when calldata hash matches tradeId", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const base = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(base.reader);
  await signPayerSubmit(store, { info, paymentTx: base.paymentTx, delivery: "none" });
  await signSellerSubmit(store, { info, paymentTx: base.paymentTx, delivery: "none" });
  setE6ChainReaderForTests(mockChainReader({ tradeId, info, txReverted: true }).reader);
  const json = await publicJsonForTrade(store, tradeId);
  assert.equal(json?.chainFacts.status, "matched");
  assert.equal(json?.chainFacts.authorizeTx?.status, "reverted");
  assert.ok(json?.chainFacts.paymentInfo?.payer);
  const blob = JSON.stringify(json);
  assert.ok(!/\bnot_paid\b/.test(blob));
  assert.ok(!/\bnot_delivered\b/.test(blob));
});

test("[p2d] panel shows reverted authorize and all chain facts", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const base = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(base.reader);
  await signPayerSubmit(store, { info, paymentTx: base.paymentTx, delivery: "none" });
  await signSellerSubmit(store, { info, paymentTx: base.paymentTx, delivery: "none" });
  setE6ChainReaderForTests(mockChainReader({ tradeId, info, txReverted: true }).reader);
  const json = await publicJsonForTrade(store, tradeId);
  assert.ok(json);
  const rows = tradeDisputeDisplayRows(json);
  const surface = rows.map((r) => `${r.label} ${r.value}`).join("\n");
  assert.match(surface, /reverted/);
  assert.match(surface, /Payment state collected/);
  assert.match(surface, /Read at block/);
  assert.ok(json.chainFacts.readAtBlock);
  assert.match(surface, new RegExp(json.chainFacts.readAtBlock!));
  assert.ok(json.chainFacts.amount);
  assert.match(surface, new RegExp(json.chainFacts.amount!));
  assert.ok(json.chainFacts.authorizeTx?.blockTimestamp);
  assert.match(surface, /Authorize tx block timestamp/);
});

test("[p2d] buildChainFacts reads every named tx and reports namedTxs", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const payerTx = "0x" + "a".repeat(64);
  const sellerTx = "0x" + "b".repeat(64);
  const wrongTx = "0x" + "c".repeat(64);
  const { reader } = mockChainReader({ tradeId, info, paymentTx: payerTx, altPaymentTx: sellerTx });
  setE6ChainReaderForTests(reader);
  await signPayerSubmit(store, { info, paymentTx: payerTx, delivery: "none" });
  await signSellerSubmit(store, { info, paymentTx: sellerTx, delivery: "none" });
  const withWrong = mockChainReader({ tradeId, info, paymentTx: payerTx, altPaymentTx: sellerTx });
  setE6ChainReaderForTests(withWrong.reader);
  const legs = await store.getLegs(tradeId);
  const readerOnly = withWrong.reader;
  const { buildChainFacts } = await import("@/lib/observatory/trade-dispute-judge");
  let facts = await buildChainFacts(readerOnly, tradeId, legs.payer.current?.paymentTx ?? null, wrongTx);
  assert.equal(facts.status, "matched");
  assert.deepEqual(
    facts.namedTxs.map((t) => t.match).sort(),
    ["matched", "unmatched"],
  );
  facts = await buildChainFacts(readerOnly, tradeId, wrongTx, wrongTx);
  assert.equal(facts.status, "unmatched");
  assert.equal(facts.namedTxs.length, 1);
});

test("[p2d] panel lists earlier claims after delivery updates", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const { reader, paymentTx } = mockChainReader({ tradeId, info });
  setE6ChainReaderForTests(reader);
  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "none" })).ok, true);
  assert.equal((await signSellerSubmit(store, { info, paymentTx, delivery: "delivered", deliveredBody: "b" })).ok, true);
  const json = await publicJsonForTrade(store, tradeId);
  assert.ok(json);
  const rows = tradeDisputeDisplayRows(json);
  const earlier = rows.filter((r) => r.label === "Seller earlier claim");
  assert.equal(earlier.length, 1);
  assert.match(earlier[0]!.value, /delivery none/);
  assert.match(rows.find((r) => r.label === "Seller current")?.value ?? "", /delivery delivered/);
});

test("[p2d] submit rejects malformed tradeId paymentTx and signature", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  setE6ChainReaderForTests(mockChainReader({ tradeId, info }).reader);
  const issued = new Date().toISOString();
  const paymentTx = "0x" + "a".repeat(64);
  const baseMsg = {
    action: "submit",
    side: "payer" as const,
    chain: "eip155:84532",
    paymentTx,
    delivery: "none" as const,
    issued,
  };
  let res = await submitTradeDisputeLeg({ ...baseMsg, tradeId: "0xshort", signature: "0x" + "d".repeat(130) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "invalid_request");
  res = await submitTradeDisputeLeg({
    ...baseMsg,
    tradeId,
    paymentTx: "0x" + "a".repeat(62),
    signature: "0x" + "d".repeat(130),
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "invalid_request");
  const msg = tradeDisputeLegSignMessage({
    tradeId,
    side: "payer",
    paymentTx,
    delivery: "none",
    receivedBodySha256: null,
    issued,
  });
  const sig = await PAYER.signMessage({ message: msg });
  res = await submitTradeDisputeLeg({
    ...baseMsg,
    tradeId,
    signature: sig.slice(0, -2),
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "invalid_signature");
});

test("[p2d] classifyEscrowCall distinguishes rejection cases", () => {
  const escrow = ESCROW.toLowerCase();
  assert.equal(
    classifyEscrowCall({
      receipt: { status: "reverted" },
      tx: { from: PAYER.address, to: escrow, input: "0x" },
      escrow,
    }),
    "rejected",
  );
  assert.equal(classifyEscrowCall({ receipt: null, tx: null, escrow }), "rejected");
});

test("[p2d] P2 write path has no db.transaction and no advisory lock", () => {
  const root = join(process.cwd(), "src/lib/observatory");
  for (const file of ["trade-dispute-store.ts", "trade-dispute-submit.ts", "trade-dispute-judge.ts"]) {
    const src = readFileSync(join(root, file), "utf8");
    assert.ok(!src.includes(".transaction("), `${file} must not use db.transaction`);
    assert.ok(!src.includes("pg_advisory"), `${file} must not use advisory locks`);
  }
});

test("[p2d] trade claims SQL guards an old table shape", () => {
  const sqlPath = join(process.cwd(), "scripts/sql/2026-11-16-trade-claims.sql");
  const legacy = join(process.cwd(), "scripts/sql/2026-11-14-trade-dispute-legs.sql");
  assert.ok(!existsSync(legacy), "legacy SQL file must be renamed away");
  const text = readFileSync(sqlPath, "utf8");
  assert.ok(text.includes("DO $$"), "shape guard DO block");
  assert.ok(text.includes("RAISE EXCEPTION"), "must RAISE on mismatch");
  assert.ok(text.includes("trade_dispute_legs exists with a different shape"), "legs guard message");
  assert.ok(text.includes("payer_state"), "detect legacy p2b columns");
  assert.ok(text.includes("accepted_at"), "expected column list");
  assert.ok(text.includes("INCIDENT_RUNBOOK.md §6"), "runbook rollback reference");
});

test("[p2d] openapi P2 error list matches submit reasons", () => {
  const submit = readFileSync(join(process.cwd(), "src/lib/observatory/trade-dispute-submit.ts"), "utf8");
  const tradeRoute = readFileSync(
    join(process.cwd(), "src/app/api/v1/observatory/disputes/trade/route.ts"),
    "utf8",
  );
  const disputesGet = readFileSync(join(process.cwd(), "src/app/api/v1/observatory/disputes/route.ts"), "utf8");
  const dayRoute = readFileSync(join(process.cwd(), "src/app/api/v1/observatory/disputes/day/route.ts"), "utf8");

  const fromCode = (src: string) => {
    const out = new Set<string>();
    for (const line of src.split("\n")) {
      for (const key of ["reason:", "error:"] as const) {
        const idx = line.indexOf(key);
        if (idx < 0) continue;
        const tail = line.slice(idx + key.length);
        for (const m of tail.matchAll(/"([a-z][a-z0-9_]*)"/g)) out.add(m[1]!);
      }
    }
    return out;
  };
  const impl = new Set([
    ...fromCode(submit),
    ...fromCode(tradeRoute),
    ...fromCode(disputesGet.split("export async function POST")[0] ?? disputesGet),
    ...fromCode(dayRoute),
  ]);

  const yaml = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
  const pathMarks = [
    "/api/v1/observatory/disputes/day:",
    "/api/v1/observatory/disputes/trade:",
    "/api/v1/observatory/disputes:",
  ];
  const documented = new Set<string>();
  for (let i = 0; i < pathMarks.length; i++) {
    const start = yaml.indexOf(pathMarks[i]!);
    assert.ok(start >= 0, pathMarks[i]);
    let end = yaml.indexOf("\n  /api/", start + pathMarks[i]!.length);
    if (end < 0) end = yaml.length;
    if (pathMarks[i] === "/api/v1/observatory/disputes:") {
      const postAt = yaml.indexOf("    post:", start);
      if (postAt >= 0 && postAt < end) end = postAt;
    }
    const chunk = yaml.slice(start, end);
    for (const m of chunk.matchAll(/`([a-z][a-z0-9_]*)`/g)) documented.add(m[1]!);
  }

  for (const code of impl) {
    assert.ok(documented.has(code), `openapi missing P2 error: ${code}`);
  }
  for (const code of documented) {
    assert.ok(impl.has(code), `openapi documents unused P2 error: ${code}`);
  }
});

test("[p2d] namedTxs keeps an unreadable tx as unavailable", async () => {
  const info = defaultPaymentInfo();
  const tradeId = tradeIdFor(info);
  const payerTx = ("0x" + "a".repeat(64)).toLowerCase();
  const sellerTx = ("0x" + "b".repeat(64)).toLowerCase();
  const block = 5_828_244;
  const reader: E6ChainReader = {
    async readPaymentState() {
      return { collected: true, capturable: "1000", refundable: "0" };
    },
    async readPaymentStateAtBlock() {
      return { collected: true, capturable: "1000", refundable: "0" };
    },
    async getPaymentInfoHash() {
      return tradeId.toLowerCase();
    },
    async getEscrowCall(txHash) {
      if (txHash.toLowerCase() === sellerTx) return "unavailable";
      return {
        from: info.operator.toLowerCase(),
        selector: AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase(),
        input: authorizeCalldata(info),
      };
    },
    async getTxFacts(txHash) {
      if (txHash.toLowerCase() === sellerTx) return "unavailable";
      return {
        from: info.operator.toLowerCase(),
        to: ESCROW.toLowerCase(),
        status: "success",
        input: authorizeCalldata(info),
      };
    },
    async getLatestBlockTimestamp() {
      return Math.floor(Date.now() / 1000);
    },
    async getLatestBlockNumber() {
      return block;
    },
    async readAuthorizeAtBlock(txHash) {
      if (txHash.toLowerCase() === sellerTx) return "unavailable";
      if (txHash.toLowerCase() !== payerTx) return "not_found";
      return {
        hash: payerTx,
        blockNumber: block,
        blockTimestamp: Math.floor(Date.now() / 1000),
        status: "success",
        input: authorizeCalldata(info),
        paymentInfo: decodeAuthorizePaymentInfo(authorizeCalldata(info)),
      };
    },
    async paymentTxPaysTo() {
      return true;
    },
  };
  const { buildChainFacts } = await import("@/lib/observatory/trade-dispute-judge");
  const facts = await buildChainFacts(reader, tradeId, payerTx, sellerTx);
  assert.equal(facts.status, "matched");
  assert.equal(facts.namedTxs.length, 2);
  assert.deepEqual(
    [...facts.namedTxs].sort((a, b) => a.hash.localeCompare(b.hash)).map((t) => t.match),
    ["matched", "unavailable"],
  );
});