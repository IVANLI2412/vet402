// ============================================================
// P2d — 争いの窓口 Postgres 試験（TEST_DATABASE_URL のみ）。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import {
  AUTH_CAPTURE_ESCROW_ABI,
  AUTH_CAPTURE_AUTHORIZE_SELECTOR,
  decodeAuthorizePaymentInfo,
  setE6ChainReaderForTests,
  type E6ChainReader,
} from "@/lib/observatory/e6-chain-reader";
import {
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
import { hashPaymentInfo, type AuthCapturePaymentInfoTuple } from "@/lib/observatory/trade-dispute";
import {
  resetTradeDisputeWriteLimitsForTests,
  setTradeDisputeWriteLimitsForTests,
} from "@/lib/observatory/trade-dispute-write-limits";
import { submitTradeDisputeLeg } from "@/lib/observatory/trade-dispute-submit";
import {
  publicJsonForTrade,
  sealTradeDisputeDay,
  setTradeDisputeStoreForTests,
} from "@/lib/observatory/trade-dispute-store";

const TEST_DB = process.env.TEST_DATABASE_URL;

const ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const CHAIN_ID = 84532;

const PAYER = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const SELLER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

function defaultPaymentInfo(
  salt = 88n,
  parties: { payer?: string; receiver?: string; operator?: string } = {},
): AuthCapturePaymentInfoTuple {
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
  const hex = (0x2000n + BigInt(i)).toString(16).padStart(64, "0");
  return privateKeyToAccount(`0x${hex}`);
}

function authorizeCalldata(info: AuthCapturePaymentInfoTuple): Hex {
  const tuple = {
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
  return encodeFunctionData({
    abi: AUTH_CAPTURE_ESCROW_ABI,
    functionName: "authorize",
    args: [tuple, 1_000_000n, USDC, "0x"],
  });
}

function mockChainReader(tradeId: string, info: AuthCapturePaymentInfoTuple, paymentTx: string): E6ChainReader {
  const block = 12345678;
  return {
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
      if (txHash.toLowerCase() !== paymentTx) return "not_found";
      return {
        from: info.operator.toLowerCase(),
        selector: AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase(),
        input: authorizeCalldata(info),
      };
    },
    async getTxFacts(txHash) {
      if (txHash.toLowerCase() !== paymentTx) return "not_found";
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
      if (txHash.toLowerCase() !== paymentTx) return "not_found";
      return {
        hash: paymentTx,
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
}

async function ensureTables() {
  const { getDb } = await import("@/lib/db/client");
  const db = getDb()!;
  await db.execute(sql`DROP TABLE IF EXISTS trade_dispute_legs CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS trade_dispute_day_roots CASCADE`);
  await db.execute(sql`
    CREATE TABLE trade_dispute_legs (
      id bigserial PRIMARY KEY,
      trade_id text NOT NULL,
      side text NOT NULL,
      chain text NOT NULL,
      payer text NOT NULL,
      receiver text NOT NULL,
      payment_info_operator text NOT NULL,
      signer text NOT NULL,
      payment_tx text NOT NULL,
      delivery text NOT NULL,
      received_body_sha256 text,
      payment_seen text,
      delivered_body_sha256 text,
      seller_receipt_commitment text,
      seller_receipt_signature text,
      seller_receipt_issued text,
      commitment text NOT NULL,
      issued text NOT NULL,
      accepted_at timestamptz NOT NULL,
      CONSTRAINT trade_dispute_legs_side_check CHECK (side IN ('payer', 'seller')),
      CONSTRAINT trade_dispute_legs_chain_check CHECK (chain = 'eip155:84532'),
      CONSTRAINT trade_dispute_legs_trade_id_check CHECK (trade_id ~ '^0x[0-9a-f]{64}$'),
      CONSTRAINT trade_dispute_legs_trade_side_issued_unique UNIQUE (trade_id, side, issued)
    )
  `);
  await db.execute(sql`CREATE INDEX trade_dispute_legs_trade_side_idx ON trade_dispute_legs (trade_id, side)`);
  await db.execute(sql`CREATE INDEX trade_dispute_legs_signer_accepted_idx ON trade_dispute_legs (signer, accepted_at)`);
  await db.execute(sql`
    CREATE TABLE trade_dispute_day_roots (
      day date PRIMARY KEY,
      root_hash text NOT NULL,
      prev_root text,
      entry_count integer NOT NULL,
      payload text NOT NULL,
      sealed_at timestamptz NOT NULL,
      CONSTRAINT trade_dispute_day_roots_hash_check CHECK (root_hash ~ '^[0-9a-f]{64}$')
    )
  `);
}

async function truncateLegs() {
  assertTestDatabaseIsNotProduction(TEST_DB!);
  const { getDb } = await import("@/lib/db/client");
  const db = getDb()!;
  await db.execute(sql`TRUNCATE trade_dispute_legs, trade_dispute_day_roots`);
}

if (!TEST_DB) {
  test("[p2d] pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  afterEach(async () => {
    setE6ChainReaderForTests(null);
    setTradeDisputeStoreForTests(null);
    resetTradeDisputeWriteLimitsForTests();
    await truncateLegs();
  });

  test("[p2d] pg bilateral claims and chain facts public JSON", async () => {
    await ensureTables();
    setTradeDisputeStoreForTests(null);
    const { getTradeDisputeStore } = await import("@/lib/observatory/trade-dispute-store");
    const store = getTradeDisputeStore()!;
    const info = defaultPaymentInfo();
    const tradeId = tradeIdFor(info);
    const paymentTx = "0x" + "a".repeat(64);
    setE6ChainReaderForTests(mockChainReader(tradeId, info, paymentTx));
    const issued = new Date().toISOString();
    const body = hashDeliveredBody("pg-body");
    const payerMsg = tradeDisputeLegSignMessage({
      tradeId,
      side: "payer",
      paymentTx,
      delivery: "received",
      receivedBodySha256: body,
      issued,
    });
    const payerSig = await PAYER.signMessage({ message: payerMsg });
    assert.equal(
      (
        await submitTradeDisputeLeg(
          {
            action: "submit",
            side: "payer",
            tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx,
            delivery: "received",
            receivedBodySha256: body,
            issued,
            signature: payerSig,
          },
          store,
        )
      ).ok,
      true,
    );

    const sellerMsg = tradeDisputeLegSignMessage({
      tradeId,
      side: "seller",
      paymentTx,
      paymentSeen: "yes",
      delivery: "delivered",
      deliveredBodySha256: body,
      issued,
    });
    const sellerSig = await SELLER.signMessage({ message: sellerMsg });
    assert.equal(
      (
        await submitTradeDisputeLeg(
          {
            action: "submit",
            side: "seller",
            tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx,
            paymentSeen: "yes",
            delivery: "delivered",
            deliveredBodySha256: body,
            issued,
            signature: sellerSig,
          },
          store,
        )
      ).ok,
      true,
    );

    const json = await publicJsonForTrade(store, tradeId);
    assert.ok(json);
    assert.equal(json.recordKind, "claims_and_chain_facts");
    assert.equal(json.chainFacts.status, "matched");
    assert.doesNotMatch(JSON.stringify(json), /not_paid|verdict/i);
    const legs = await store.listAllLegs();
    assert.equal(await countPublicTradeDisputes(legs), 1);
  });

  test("[p2d] pg sealTradeDisputeDay counts history rows", async () => {
    await ensureTables();
    setTradeDisputeStoreForTests(null);
    const { getTradeDisputeStore } = await import("@/lib/observatory/trade-dispute-store");
    const store = getTradeDisputeStore()!;
    const info = defaultPaymentInfo();
    const tradeId = tradeIdFor(info);
    const paymentTx = "0x" + "a".repeat(64);
    setE6ChainReaderForTests(mockChainReader(tradeId, info, paymentTx));
    const issued1 = new Date().toISOString();
    const noneMsg = tradeDisputeLegSignMessage({
      tradeId,
      side: "seller",
      paymentTx,
      paymentSeen: "yes",
      delivery: "none",
      deliveredBodySha256: null,
      issued: issued1,
    });
  const noneSig = await SELLER.signMessage({ message: noneMsg });
    assert.equal(
      (
        await submitTradeDisputeLeg(
          {
            action: "submit",
            side: "seller",
            tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx,
            paymentSeen: "yes",
            delivery: "none",
            deliveredBodySha256: "none",
            issued: issued1,
            signature: noneSig,
          },
          store,
        )
      ).ok,
      true,
    );
    await new Promise((r) => setTimeout(r, 5));
    const issued2 = new Date().toISOString();
    const delMsg = tradeDisputeLegSignMessage({
      tradeId,
      side: "seller",
      paymentTx,
      paymentSeen: "yes",
      delivery: "delivered",
      deliveredBodySha256: hashDeliveredBody("z"),
      issued: issued2,
    });
    const delSig = await SELLER.signMessage({ message: delMsg });
    assert.equal(
      (
        await submitTradeDisputeLeg(
          {
            action: "submit",
            side: "seller",
            tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx,
            paymentSeen: "yes",
            delivery: "delivered",
            deliveredBodySha256: hashDeliveredBody("z"),
            issued: issued2,
            signature: delSig,
          },
          store,
        )
      ).ok,
      true,
    );

    const day = new Date().toISOString().slice(0, 10);
    const sealed = await sealTradeDisputeDay(day);
    assert.equal(sealed.status, "sealed");
    if (sealed.status === "sealed") {
      assert.equal(sealed.entryCount, 2);
    }

    const { GET } = await import("@/app/api/v1/observatory/disputes/day/route");
    const res = await GET(new NextRequest(`http://x/api/v1/observatory/disputes/day?day=${day}`));
    assert.equal(res.status, 200);
    const dayBody = await res.json();
    const legs = await store.listAllLegs();
    const commitments = commitmentsForUtcDay(
      day,
      legs.map((r) => ({ commitment: r.commitment, acceptedAt: r.acceptedAt })),
    );
    assert.equal(dayBody.payload, tradeDisputeDayPayload(day, commitments));
    assert.equal(
      dayBody.rootHash,
      tradeDisputeDayRootHash(dayBody.prevRoot === "genesis" ? null : dayBody.prevRoot, day, commitments),
    );
  });

  test("[p2d] pg wallet write limit does not block other party", async () => {
    await ensureTables();
    setTradeDisputeWriteLimitsForTests(1, 10);
    setTradeDisputeStoreForTests(null);
    const { getTradeDisputeStore } = await import("@/lib/observatory/trade-dispute-store");
    const store = getTradeDisputeStore()!;
    const info = defaultPaymentInfo();
    const tradeId = tradeIdFor(info);
    const paymentTx = "0x" + "a".repeat(64);
    setE6ChainReaderForTests(mockChainReader(tradeId, info, paymentTx));

    const issuedP = new Date().toISOString();
    const pMsg = tradeDisputeLegSignMessage({
      tradeId,
      side: "payer",
      paymentTx,
      delivery: "none",
      receivedBodySha256: null,
      issued: issuedP,
    });
    const pSig = await PAYER.signMessage({ message: pMsg });
    assert.equal(
      (
        await submitTradeDisputeLeg(
          {
            action: "submit",
            side: "payer",
            tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx,
            delivery: "none",
            receivedBodySha256: "none",
            issued: issuedP,
            signature: pSig,
          },
          store,
        )
      ).ok,
      true,
    );
    const issuedS = new Date().toISOString();
    const sMsg = tradeDisputeLegSignMessage({
      tradeId,
      side: "seller",
      paymentTx,
      paymentSeen: "yes",
      delivery: "none",
      deliveredBodySha256: null,
      issued: issuedS,
    });
    const sSig = await SELLER.signMessage({ message: sMsg });
    const seller = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "seller",
        tradeId,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx,
        paymentSeen: "yes",
        delivery: "none",
        deliveredBodySha256: "none",
        issued: issuedS,
        signature: sSig,
      },
      store,
    );
    assert.equal(seller.ok, true);
  });

  test("[p2d] pg concurrent same-wallet writes may exceed daily cap 20 (<= 25)", async () => {
    await ensureTables();
    setTradeDisputeWriteLimitsForTests(20, 10);
    setTradeDisputeStoreForTests(null);
    const { getTradeDisputeStore } = await import("@/lib/observatory/trade-dispute-store");
    const store = getTradeDisputeStore()!;

    const trades = Array.from({ length: 25 }, (_, i) => {
      const info = defaultPaymentInfo(BigInt(9000 + i));
      return {
        info,
        tradeId: tradeIdFor(info),
        paymentTx: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      };
    });

    const multiReader: E6ChainReader = {
      async readPaymentState() {
        return { collected: true, capturable: "1000", refundable: "0" };
      },
      async readPaymentStateAtBlock() {
        return { collected: true, capturable: "1000", refundable: "0" };
      },
      async getPaymentInfoHash(_escrow, paymentInfo) {
        const payer = (paymentInfo as { payer: string }).payer.toLowerCase();
        return hashPaymentInfo(CHAIN_ID, paymentInfo as never, payer, ESCROW);
      },
      async getEscrowCall(txHash) {
        const t = trades.find((x) => x.paymentTx === txHash.toLowerCase());
        if (!t) return "not_found";
        return {
          from: t.info.operator.toLowerCase(),
          selector: AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase(),
          input: authorizeCalldata(t.info),
        };
      },
      async getTxFacts(txHash) {
        const t = trades.find((x) => x.paymentTx === txHash.toLowerCase());
        if (!t) return "not_found";
        return {
          from: t.info.operator.toLowerCase(),
          to: ESCROW.toLowerCase(),
          status: "success",
          input: authorizeCalldata(t.info),
        };
      },
      async getLatestBlockTimestamp() {
        return Math.floor(Date.now() / 1000);
      },
      async getLatestBlockNumber() {
        return 99_001;
      },
      async readAuthorizeAtBlock(txHash) {
        const t = trades.find((x) => x.paymentTx === txHash.toLowerCase());
        if (!t) return "not_found";
        return {
          hash: txHash.toLowerCase(),
          blockNumber: 99_001,
          blockTimestamp: Math.floor(Date.now() / 1000),
          status: "success",
          input: authorizeCalldata(t.info),
          paymentInfo: decodeAuthorizePaymentInfo(authorizeCalldata(t.info)),
        };
      },
      async paymentTxPaysTo() {
        return true;
      },
    };
    setE6ChainReaderForTests(multiReader);

    const results = await Promise.all(
      trades.map(async (t, i) => {
        const issued = new Date(Date.now() + i).toISOString();
        const msg = tradeDisputeLegSignMessage({
          tradeId: t.tradeId,
          side: "payer",
          paymentTx: t.paymentTx,
          delivery: "none",
          receivedBodySha256: null,
          issued,
        });
        const sig = await PAYER.signMessage({ message: msg });
        return submitTradeDisputeLeg(
          {
            action: "submit",
            side: "payer",
            tradeId: t.tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx: t.paymentTx,
            delivery: "none",
            receivedBodySha256: "none",
            issued,
            signature: sig,
          },
          store,
        );
      }),
    );
    const inserted = results.filter((r) => r.ok).length;
    assert.ok(inserted <= 25, `inserted ${inserted}`);
    assert.ok(inserted >= 1, "at least one write must succeed");

    const t0 = trades[0]!;
    const sellerIssued = new Date().toISOString();
    const sellerMsg = tradeDisputeLegSignMessage({
      tradeId: t0.tradeId,
      side: "seller",
      paymentTx: t0.paymentTx,
      paymentSeen: "yes",
      delivery: "none",
      deliveredBodySha256: null,
      issued: sellerIssued,
    });
    const sellerSig = await SELLER.signMessage({ message: sellerMsg });
    const sellerRes = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "seller",
        tradeId: t0.tradeId,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx: t0.paymentTx,
        paymentSeen: "yes",
        delivery: "none",
        deliveredBodySha256: "none",
        issued: sellerIssued,
        signature: sellerSig,
      },
      store,
    );
    assert.equal(sellerRes.ok, true);
  });

  test("[p2d] pg T10d one database no global write cap across thirty trades", async () => {
    await ensureTables();
    setTradeDisputeWriteLimitsForTests(25, 25);
    setTradeDisputeStoreForTests(null);
    const { getTradeDisputeStore } = await import("@/lib/observatory/trade-dispute-store");
    const store = getTradeDisputeStore()!;

    const trades = Array.from({ length: 30 }, (_, i) => {
      const payer = walletForIndex(i * 2);
      const seller = walletForIndex(i * 2 + 1);
      const info = defaultPaymentInfo(BigInt(7000 + i), {
        payer: payer.address,
        receiver: seller.address,
        operator: seller.address,
      });
      return {
        info,
        tradeId: tradeIdFor(info),
        paymentTx: `0x${(7000 + i).toString(16).padStart(64, "0")}`,
        payer,
      };
    });

    const bulkReader: E6ChainReader = {
      async readPaymentState() {
        return { collected: true, capturable: "1000", refundable: "0" };
      },
      async readPaymentStateAtBlock() {
        return { collected: true, capturable: "1000", refundable: "0" };
      },
      async getPaymentInfoHash(_escrow, paymentInfo) {
        const payer = (paymentInfo as { payer: string }).payer.toLowerCase();
        return hashPaymentInfo(CHAIN_ID, paymentInfo as never, payer, ESCROW);
      },
      async getEscrowCall(txHash) {
        const t = trades.find((x) => x.paymentTx === txHash.toLowerCase());
        if (!t) return "not_found";
        return {
          from: t.info.operator.toLowerCase(),
          selector: AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase(),
          input: authorizeCalldata(t.info),
        };
      },
      async getTxFacts(txHash) {
        const t = trades.find((x) => x.paymentTx === txHash.toLowerCase());
        if (!t) return "not_found";
        return {
          from: t.info.operator.toLowerCase(),
          to: ESCROW.toLowerCase(),
          status: "success",
          input: authorizeCalldata(t.info),
        };
      },
      async getLatestBlockTimestamp() {
        return Math.floor(Date.now() / 1000);
      },
      async getLatestBlockNumber() {
        return 99_002;
      },
      async readAuthorizeAtBlock(txHash) {
        const t = trades.find((x) => x.paymentTx === txHash.toLowerCase());
        if (!t) return "not_found";
        return {
          hash: txHash.toLowerCase(),
          blockNumber: 99_002,
          blockTimestamp: Math.floor(Date.now() / 1000),
          status: "success",
          input: authorizeCalldata(t.info),
          paymentInfo: decodeAuthorizePaymentInfo(authorizeCalldata(t.info)),
        };
      },
      async paymentTxPaysTo() {
        return true;
      },
    };
    setE6ChainReaderForTests(bulkReader);

    let okCount = 0;
    for (const t of trades) {
      for (let n = 0; n < 20; n++) {
        const issued = new Date(Date.now() + okCount).toISOString();
        const msg = tradeDisputeLegSignMessage({
          tradeId: t.tradeId,
          side: "payer",
          paymentTx: t.paymentTx,
          delivery: "none",
          receivedBodySha256: null,
          issued,
        });
        const sig = await t.payer.signMessage({ message: msg });
        const res = await submitTradeDisputeLeg(
          {
            action: "submit",
            side: "payer",
            tradeId: t.tradeId,
            chain: TRADE_DISPUTE_CHAIN,
            paymentTx: t.paymentTx,
            delivery: "none",
            receivedBodySha256: "none",
            issued,
            signature: sig,
          },
          store,
        );
        assert.equal(res.ok, true, `${t.tradeId} write ${n}`);
        okCount++;
      }
    }
    assert.equal(okCount, 600);
  });

  test("[p2d] pg insert works on a db without transaction support (neon-http shape)", async () => {
    await ensureTables();
    await truncateLegs();
    resetTradeDisputeWriteLimitsForTests();
    setE6ChainReaderForTests(null);
    const { getDb } = await import("@/lib/db/client");
    const realDb = getDb()!;
    const db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return () => {
            throw new Error("No transactions support in neon-http driver");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { pgTradeDisputeStore } = await import("@/lib/observatory/trade-dispute-store");
    const store = pgTradeDisputeStore(db);

    const info = defaultPaymentInfo(44n);
    const tradeId = tradeIdFor(info);
    const paymentTx = "0x" + "f".repeat(64);
    setE6ChainReaderForTests(mockChainReader(tradeId, info, paymentTx));

    const issued1 = new Date().toISOString();
    const msg1 = tradeDisputeLegSignMessage({
      tradeId,
      side: "payer",
      paymentTx,
      delivery: "none",
      receivedBodySha256: null,
      issued: issued1,
    });
    const sig1 = await PAYER.signMessage({ message: msg1 });
    const ok = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "payer",
        tradeId,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx,
        delivery: "none",
        receivedBodySha256: "none",
        issued: issued1,
        signature: sig1,
      },
      store,
    );
    assert.equal(ok.ok, true);
    const legs = await store.getLegs(tradeId);
    assert.ok(legs.payer.current);

    const dup = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "payer",
        tradeId,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx,
        delivery: "none",
        receivedBodySha256: "none",
        issued: issued1,
        signature: sig1,
      },
      store,
    );
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.reason, "already_recorded");

    const issuedStale = new Date(Date.parse(issued1) - 60_000).toISOString();
    const msgStale = tradeDisputeLegSignMessage({
      tradeId,
      side: "payer",
      paymentTx,
      delivery: "none",
      receivedBodySha256: null,
      issued: issuedStale,
    });
    const sigStale = await PAYER.signMessage({ message: msgStale });
    const stale = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "payer",
        tradeId,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx,
        delivery: "none",
        receivedBodySha256: "none",
        issued: issuedStale,
        signature: sigStale,
      },
      store,
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, "stale_claim");

    // PAYER は同じ日に上で 1 件書いているので、財布の上限 2・側の上限 1 で「1 件目は通り 2 件目は止まる」を見る。
    setTradeDisputeWriteLimitsForTests(2, 1);
    const info2 = defaultPaymentInfo(45n);
    const tradeId2 = tradeIdFor(info2);
    const paymentTx2 = "0x" + "e".repeat(64);
    const reader2 = mockChainReader(tradeId2, info2, paymentTx2);
    setE6ChainReaderForTests(reader2);
    const issuedCap = new Date().toISOString();
    const msgCap = tradeDisputeLegSignMessage({
      tradeId: tradeId2,
      side: "payer",
      paymentTx: paymentTx2,
      delivery: "none",
      receivedBodySha256: null,
      issued: issuedCap,
    });
    const sigCap = await PAYER.signMessage({ message: msgCap });
    const first = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "payer",
        tradeId: tradeId2,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx: paymentTx2,
        delivery: "none",
        receivedBodySha256: "none",
        issued: issuedCap,
        signature: sigCap,
      },
      store,
    );
    assert.equal(first.ok, true);
    const issuedCap2 = new Date(Date.parse(issuedCap) + 1000).toISOString();
    const msgCap2 = tradeDisputeLegSignMessage({
      tradeId: tradeId2,
      side: "payer",
      paymentTx: paymentTx2,
      delivery: "none",
      receivedBodySha256: null,
      issued: issuedCap2,
    });
    const sigCap2 = await PAYER.signMessage({ message: msgCap2 });
    const capped = await submitTradeDisputeLeg(
      {
        action: "submit",
        side: "payer",
        tradeId: tradeId2,
        chain: TRADE_DISPUTE_CHAIN,
        paymentTx: paymentTx2,
        delivery: "none",
        receivedBodySha256: "none",
        issued: issuedCap2,
        signature: sigCap2,
      },
      store,
    );
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.equal(capped.reason, "write_limit_reached");
  });

  test("[p2d] pg trade claims SQL refuses an old table shape", async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    await db.execute(sql`DROP TABLE IF EXISTS trade_dispute_day_roots CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS trade_dispute_legs CASCADE`);
    await db.execute(sql`
      CREATE TABLE trade_dispute_legs (
        id bigserial PRIMARY KEY,
        trade_id text NOT NULL,
        payer_state text,
        operator text,
        chain_collected boolean,
        pre_approval_expiry timestamptz
      )
    `);
    const migration = readFileSync(join(process.cwd(), "scripts/sql/2026-11-16-trade-claims.sql"), "utf8");
    await assert.rejects(async () => {
      await db.execute(sql.raw(migration));
    }, /different shape/);
    await ensureTables();
  });

  test("[p2d] pg claim SQL runs with every argument sent as text (neon-http untyped parameters)", async () => {
    await ensureTables();
    await truncateLegs();
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const {
      tradeClaimInsertSql,
      tradeClaimDuplicateSql,
      tradeClaimLatestIssuedSql,
    } = await import("@/lib/observatory/trade-dispute-store");
    const dialect = new PgDialect();
    const rowsFrom = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    // neon-http と同じく、全部の引数を text として流す（$n を '...'::text に置き換える）。
    const asText = (q: ReturnType<typeof sql>) => {
      const { sql: text, params } = dialect.sqlToQuery(q);
      let out = text;
      for (let i = params.length; i >= 1; i--) {
        const v = params[i - 1];
        const lit = v === null || v === undefined ? "NULL::text" : `'${String(v).replace(/'/g, "''")}'::text`;
        out = out.split(`$${i}`).join(`(${lit})`);
      }
      return sql.raw(out);
    };
    // 対照: 型を付けない比較は text の引数で落ちる（この置き換えが本番の穴を再現できること）。
    await assert.rejects(db.execute(asText(sql`SELECT 1 WHERE 1 < ${5}`)));

    const issued = new Date().toISOString();
    const row = {
      tradeId: "0x" + "c".repeat(64),
      side: "payer" as const,
      chain: TRADE_DISPUTE_CHAIN,
      payer: PAYER.address.toLowerCase(),
      receiver: SELLER.address.toLowerCase(),
      paymentInfoOperator: SELLER.address.toLowerCase(),
      signer: PAYER.address.toLowerCase(),
      paymentTx: "0x" + "d".repeat(64),
      delivery: "none",
      receivedBodySha256: null,
      paymentSeen: null,
      deliveredBodySha256: null,
      sellerReceiptCommitment: null,
      sellerReceiptSignature: null,
      sellerReceiptIssued: null,
      commitment: "e".repeat(64),
      issued,
      acceptedAt: new Date().toISOString(),
    };
    const limits = { perWallet: 20, perTradeSide: 10 };
    assert.equal(rowsFrom(await db.execute(asText(tradeClaimInsertSql(row, limits)))).length, 1);
    assert.equal(rowsFrom(await db.execute(asText(tradeClaimInsertSql(row, limits)))).length, 0);
    assert.equal(rowsFrom(await db.execute(asText(tradeClaimDuplicateSql(row.tradeId, row.side, row.issued)))).length, 1);
    const latest = rowsFrom(await db.execute(asText(tradeClaimLatestIssuedSql(row.tradeId, row.side))));
    assert.equal(latest[0]?.issued, issued);
    const later = { ...row, issued: new Date(Date.now() + 1000).toISOString() };
    assert.equal(rowsFrom(await db.execute(asText(tradeClaimInsertSql(later, { perWallet: 1, perTradeSide: 10 })))).length, 0);
    assert.equal(rowsFrom(await db.execute(asText(tradeClaimInsertSql(later, limits)))).length, 1);
  });
}
