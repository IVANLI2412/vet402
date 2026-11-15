// P3 運用画面（DB あり）
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, type Hex } from "viem";
import { AUTH_CAPTURE_ESCROW_ABI, AUTH_CAPTURE_AUTHORIZE_SELECTOR } from "@/lib/observatory/e6-chain-reader";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const ESCROW_AUTH_INPUT = encodeFunctionData({
  abi: AUTH_CAPTURE_ESCROW_ABI,
  functionName: "authorize",
  args: [
    {
      operator: "0x0000000000000000000000000000000000000abc" as Hex,
      payer: "0x0000000000000000000000000000000000000ccc" as Hex,
      receiver: "0x2222222222222222222222222222222222222222" as Hex,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex,
      maxAmount: 1_000_000n,
      preApprovalExpiry: 1,
      authorizationExpiry: 2,
      refundExpiry: 3,
      minFeeBps: 0,
      maxFeeBps: 100,
      feeReceiver: "0x0000000000000000000000000000000000000000" as Hex,
      salt: 1n,
    },
    1n,
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex,
    "0x",
  ],
});

import type { TradeDisputeLegRow } from "@/lib/observatory/trade-dispute-store";
import type { E6ChainReader } from "@/lib/observatory/e6-chain-reader";

const E6_READER_TAIL: Pick<E6ChainReader, "readPaymentStateAtBlock" | "getLatestBlockNumber" | "readAuthorizeAtBlock"> = {
  async readPaymentStateAtBlock() {
    return { collected: true, capturable: "1", refundable: "0" };
  },
  async getLatestBlockNumber() {
    return 1;
  },
  async readAuthorizeAtBlock() {
    return "not_found";
  },
};

function mergeReader(partial: Omit<E6ChainReader, keyof typeof E6_READER_TAIL>): E6ChainReader {
  return { ...partial, ...E6_READER_TAIL };
}

function disputeLeg(input: {
  tradeId: string;
  side: "payer" | "seller";
  payer: string;
  receiver: string;
  paymentInfoOperator: string;
  paymentTx: string;
  commitment: string;
  acceptedAt: string;
  receivedBodySha256?: string | null;
  deliveredBodySha256?: string | null;
  paymentSeen?: "yes" | "no" | null;
  delivery?: string;
}): TradeDisputeLegRow {
  const delivery =
    input.delivery ??
    (input.side === "payer"
      ? input.receivedBodySha256
        ? "received"
        : "none"
      : input.deliveredBodySha256
        ? "delivered"
        : "none");
  return {
    chain: "eip155:84532",
    tradeId: input.tradeId,
    side: input.side,
    payer: input.payer,
    receiver: input.receiver,
    paymentInfoOperator: input.paymentInfoOperator,
    signer: (input.side === "seller" ? input.receiver : input.payer).toLowerCase(),
    paymentTx: input.paymentTx,
    delivery,
    receivedBodySha256: input.receivedBodySha256 ?? null,
    paymentSeen: input.side === "seller" ? (input.paymentSeen ?? "yes") : null,
    deliveredBodySha256: input.deliveredBodySha256 ?? null,
    sellerReceiptCommitment: null,
    sellerReceiptSignature: null,
    sellerReceiptIssued: null,
    commitment: input.commitment,
    issued: input.acceptedAt,
    acceptedAt: input.acceptedAt,
  };
}

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("ops dashboard pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("ops dashboard buyer, seller, and webhook delivery", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql, eq } = await import("drizzle-orm");
    const { createApiKey } = await import("@/lib/db/api-keys");
    const {
      createWebhook,
      setWebhookDeliveryForTests,
      isSafeWebhookUrl,
    } = await import("@/lib/webhooks");
    const { webhooks } = await import("@/lib/db/schema");
    const {
      fetchBuyerKeyUsage,
      fetchBuyerPayments,
      fetchSellerOpsFromDb,
      setDisputePurchaseLimitForTests,
    } = await import("@/lib/dashboard/ops-data");
    const { dispatchOpsDigest } = await import("@/lib/dashboard/ops-notify");
    const { buildBuyerCard } = await import("@/lib/dashboard/ops-card");
    const { memoryTradeDisputeStore, setTradeDisputeStoreForTests } = await import(
      "@/lib/observatory/trade-dispute-store"
    );
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const prevPepper = process.env.API_KEY_PEPPER;
    process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER ?? "ops-dashboard-test-pepper-32ch";

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE webhooks, decision_usage_daily, x402_payments, x402_l1_purchases, x402_l0_probes, x402_endpoints RESTART IDENTITY CASCADE`,
    );

    const keyA = await createApiKey({ name: "ops-buyer-a" });
    const keyB = await createApiKey({ name: "ops-buyer-b" });
    const today = new Date().toISOString().slice(0, 10);
    await db.execute(sql`
      INSERT INTO decision_usage_daily (day, api_key_id, chain, count)
      VALUES (${today}::date, ${keyA.id}::uuid, 'eip155:8453', 5),
             (${today}::date, ${keyB.id}::uuid, 'eip155:8453', 99)
    `);
    await db.execute(sql`
      INSERT INTO x402_payments (wallet, tx_hash, network, resource, payee, onchain_amount, token, amount_verified, api_key_id, ownership_verified)
      VALUES ('0x0000000000000000000000000000000000000001', ${"0x" + "a1".repeat(32)}, 'base', 'https://a', '0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea', '1000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', true, ${keyA.id}::uuid, true),
             ('0x0000000000000000000000000000000000000002', ${"0x" + "a2".repeat(32)}, 'base', 'https://b', '0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea', '2000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', false, ${keyA.id}::uuid, true),
             ('0x0000000000000000000000000000000000000003', ${"0x" + "a3".repeat(32)}, 'base', 'https://c', '0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea', '3000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', true, ${keyB.id}::uuid, true)
    `);

    const usageA = await fetchBuyerKeyUsage(keyA.id);
    assert.equal(usageA.total, 5);
    assert.equal(usageA.byChain[0]?.count, 5);
    const payA = await fetchBuyerPayments(keyA.id);
    assert.equal(payA.paymentCount, 2);
    assert.equal(payA.verifiedUsdcUnitsSum, "1000000");
    assert.equal(payA.unverifiedOnChainCount, 1);

    const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
    const OTHER = "0x00000000000000000000000000000000000000ee";
    const URL = "https://seller-ops.example/api";
    const RID = resourceId("GET", URL);

    const insertEndpoint = async (
      resourceKey: string,
      url: string,
      payTo: string,
      status: string,
    ): Promise<string> => {
      const epRows = (await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                    canonical_url, resource_id, endpoint_hash, payee_id, status)
        VALUES (${resourceKey}, ${url}, 'GET', 'eip155:8453', ${payTo}, '1000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", payTo)}, ${status})
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      return (Array.isArray(epRows) ? epRows[0] : epRows.rows?.[0])!.id;
    };

    const endpointMain = await insertEndpoint("seller-ops", URL, PAY_TO, "active");
    const endpointPass = await insertEndpoint("seller-ops-pass", "https://seller-ops.example/pass", PAY_TO, "active");
    const endpointFail = await insertEndpoint("seller-ops-fail", "https://seller-ops.example/fail", PAY_TO, "active");
    const endpointWithdrawn = await insertEndpoint(
      "seller-ops-wdn",
      "https://seller-ops.example/wdn",
      PAY_TO,
      "delisted",
    );
    const endpointUnverified = await insertEndpoint(
      "seller-ops-unv",
      "https://seller-ops.example/unv",
      PAY_TO,
      "active",
    );
    await insertEndpoint("seller-ops-other", "https://other.example/api", OTHER, "active");

    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, method, verdict, http_status, fail_reason, probed_at)
      VALUES (${endpointPass}::uuid, 'GET', 'pass', 200, null, '2026-01-01T00:00:00Z'),
             (${endpointFail}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-02T00:00:00Z'),
             (${endpointFail}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-01T00:00:00Z'),
             (${endpointWithdrawn}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-02T00:00:00Z'),
             (${endpointWithdrawn}::uuid, 'GET', 'fail', 402, 'no_402', '2026-01-01T00:00:00Z')
    `);

    const purchaseInsert = (await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash, http_status_paid, payload_non_empty)
      VALUES (${endpointMain}::uuid, 'settled', 'eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ${PAY_TO}, '500000', '500000',
              '0xabc', ${"0x" + "b1".repeat(32)}, 200, true)
      RETURNING id::text AS id
    `)) as { rows?: { id: string }[] } | { id: string }[];
    const purchaseId = (Array.isArray(purchaseInsert) ? purchaseInsert[0] : purchaseInsert.rows?.[0])!.id;

    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, amount_units, spent_units, payer, tx_hash, http_status_paid, payload_non_empty)
      VALUES
        (${endpointMain}::uuid, 'settled', 'eip155:8453', ${PAY_TO}, '1', '1', '0xabc', ${"0x" + "b2".repeat(32)}, 404, true),
        (${endpointMain}::uuid, 'settle_claimed', 'eip155:8453', ${PAY_TO}, '1', '0', '0xabc', null, null, false),
        (${endpointMain}::uuid, 'settle_failed', 'eip155:8453', ${PAY_TO}, '1', '0', '0xabc', null, 500, false),
        (${endpointMain}::uuid, 'settle_failed', 'eip155:8453', ${OTHER}, '1', '0', '0xabc', null, 500, false)
    `);

    setTradeDisputeStoreForTests(
      memoryTradeDisputeStore([
        disputeLeg({
          tradeId: "0x" + "7".repeat(64),
          side: "payer",
          payer: "0x0000000000000000000000000000000000000bbb",
          receiver: PAY_TO,
          paymentInfoOperator: "0x0000000000000000000000000000000000000aaa",
          commitment: "f1".repeat(32),
          paymentTx: "0x" + "8".repeat(64),
          acceptedAt: "2026-06-01T12:00:00.000Z",
        }),
      ]),
    );

    const seller = await fetchSellerOpsFromDb(PAY_TO);
    assert.equal(seller.revenue.measurementSettledCount, 2);
    assert.equal(seller.revenue.measurementSettledUnitsSum, "500001");
    assert.equal(seller.revenue.reportedVerifiedCount, 2);
    assert.equal(seller.revenue.reportedVerifiedUnitsSum, "4000000");
    assert.equal(seller.disputes.recordsPresent, 1);
    assert.equal(seller.l1.attempts, 4);
    assert.equal(seller.l1.delivered, 1);
    assert.equal(seller.l1.inconclusive, 1);
    assert.equal(seller.l1.awaitingReread, 1);
    assert.equal(seller.reputation.pass, 1);
    assert.equal(seller.reputation.fail, 1);
    assert.equal(seller.reputation.withdrawn, 1);
    assert.equal(seller.reputation.unverified, 2);
    assert.equal(seller.disputes.truncated, false);
    assert.equal(seller.disputes.purchaseIdsChecked, 4);

    const other = await fetchSellerOpsFromDb(OTHER);
    assert.equal(other.disputes.recordsPresent, 0);
    assert.equal(other.revenue.measurementSettledCount, 0);
    assert.equal(other.l1.attempts, 1);
    assert.equal(other.l1.delivered, 0);
    assert.equal(other.l1.inconclusive, 0);
    assert.equal(other.l1.awaitingReread, 0);

    setTradeDisputeStoreForTests(null);

    const deliveries: { type: string; headers: Record<string, string>; host: string; ip?: string }[] = [];
    const publicUrl = "https://hooks.example.com/vet402";
    assert.equal(isSafeWebhookUrl(publicUrl), true);
    const created = await createWebhook({
      apiKeyId: keyA.id,
      url: publicUrl,
      events: ["ops.digest"],
    });
    assert.ok("id" in created);
    const badHttp = await createWebhook({
      apiKeyId: keyA.id,
      url: "http://hooks.example.com/vet402",
      events: ["ops.digest"],
    });
    assert.equal("error" in badHttp, true);
    if ("error" in badHttp) assert.equal(badHttp.error, "unsafe_url");

    const publicIp = "93.184.216.34";
    setWebhookDeliveryForTests({
      resolve: async () => [{ address: publicIp, family: 4 }],
      post: async (_url, ip, body, headers) => {
        const parsed = JSON.parse(body) as { type: string };
        deliveries.push({ type: parsed.type, headers, host: _url.hostname, ip });
        return true;
      },
    });
    const card = buildBuyerCard({
      yourKey: { total: 0, byChain: [], days: 30 },
      payments: { paymentCount: 0, verifiedUsdcUnitsSum: "0", unverifiedOnChainCount: 0 },
      measurementL1: { attempts: 0, delivered: 0, inconclusive: 0, awaitingReread: 0 },
    });
    await dispatchOpsDigest(keyA.id, card);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.type, "ops.digest");
    assert.equal(deliveries[0]?.ip, publicIp);
    assert.ok(deliveries[0]?.headers["Vouch-Signature"]);

    const privateHook = await createWebhook({
      apiKeyId: keyA.id,
      url: "https://private-hooks.example.com/vet402",
      events: ["ops.digest"],
    });
    assert.ok("id" in privateHook);
    const privateDeliveriesBefore = deliveries.length;
    setWebhookDeliveryForTests({
      resolve: async (hostname) =>
        hostname === "private-hooks.example.com"
          ? [{ address: "10.0.0.5", family: 4 }]
          : [{ address: publicIp, family: 4 }],
      post: async (_url, ip, body, headers) => {
        const parsed = JSON.parse(body) as { type: string };
        deliveries.push({ type: parsed.type, headers, host: _url.hostname, ip });
        return true;
      },
    });
    await dispatchOpsDigest(keyA.id, card);
    const newDeliveries = deliveries.slice(privateDeliveriesBefore);
    assert.equal(newDeliveries.some((d) => d.host === "private-hooks.example.com"), false);

    const [httpRow] = await db
      .insert(webhooks)
      .values({
        apiKeyId: keyA.id,
        url: "http://injected.example/hook",
        secret: "whsec_plaintest",
        events: ["ops.digest"],
        active: true,
      })
      .returning();
    setWebhookDeliveryForTests({
      resolve: async () => [{ address: publicIp, family: 4 }],
      post: async (url, ip, body, headers) => {
        const parsed = JSON.parse(body) as { type: string };
        deliveries.push({ type: parsed.type, headers, host: url.hostname, ip });
        return true;
      },
    });
    const beforeHttp = deliveries.length;
    await dispatchOpsDigest(keyA.id, card);
    const httpDeliveries = deliveries
      .slice(beforeHttp)
      .filter((d) => d.host === "injected.example");
    assert.equal(httpDeliveries.length, 0);
    await db.delete(webhooks).where(eq(webhooks.id, httpRow!.id));

    setWebhookDeliveryForTests(null);
    if (prevPepper === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = prevPepper;
  });

  test("seller disputes count only dispute stages on this seller's purchases", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchSellerOpsFromDb } = await import("@/lib/dashboard/ops-data");
    const { buildSellerCard } = await import("@/lib/dashboard/ops-card");
    const { memoryTradeDisputeStore, setTradeDisputeStoreForTests } = await import(
      "@/lib/observatory/trade-dispute-store"
    );
    const { setE6ChainReaderForTests } = await import("@/lib/observatory/e6-chain-reader");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints RESTART IDENTITY CASCADE`);

    const SELLER = "0x2222222222222222222222222222222222222222";
    const OTHER = "0x3333333333333333333333333333333333333333";
    const URL = "https://dispute-stage.example/api";
    const otherUrl = "https://dispute-stage-other.example/api";

    const insertEp = async (payTo: string, url: string) => {
      const resourceKey = url.replace(/^https?:\/\//, "").replace(/\//g, "_");
      const epInsert = (await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                    canonical_url, resource_id, endpoint_hash, payee_id, status)
        VALUES (${resourceKey}, ${url}, 'GET', 'eip155:8453', ${payTo}, '1000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", payTo)}, 'active')
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      return (Array.isArray(epInsert) ? epInsert[0] : epInsert.rows?.[0])!.id;
    };

    const sellerEp = await insertEp(SELLER, URL);
    const otherEp = await insertEp(OTHER, otherUrl);

    const insertPurchase = async (endpointId: string, payTo: string) => {
      const row = (await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, amount_units, spent_units, payer)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', ${payTo}, '1', '1', '0xabc')
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      return (Array.isArray(row) ? row[0] : row.rows?.[0])!.id;
    };

    await insertPurchase(sellerEp, SELLER);
    await insertPurchase(otherEp, OTHER);

    const op = "0x0000000000000000000000000000000000000abc";
    const bodyHash = "a".repeat(64);
    const tOk = "0x" + "1".repeat(64);
    const tOther = "0x" + "2".repeat(64);
    const tDispute = "0x" + "3".repeat(64);
  const baseLeg = {
      chain: "eip155:84532",
      payer: "0x0000000000000000000000000000000000000ccc",
      receiver: SELLER,
      paymentInfoOperator: op,
      acceptedAt: "2026-06-01T12:00:00.000Z",
    };

    const txToTrade = new Map([
      ["0x" + "4".repeat(64), tOk],
      ["0x" + "6".repeat(64), tDispute],
    ]);
    let hashForValidate = "";
    setE6ChainReaderForTests(
      mergeReader({
        async readPaymentState() {
          return { collected: true, capturable: "1", refundable: "0" };
        },
        async getPaymentInfoHash() {
          return hashForValidate;
        },
        async getEscrowCall(txHash) {
          const tid = txToTrade.get(txHash.toLowerCase());
          if (!tid) return "rejected";
          hashForValidate = tid;
          return {
            from: baseLeg.payer,
            selector: AUTH_CAPTURE_AUTHORIZE_SELECTOR.toLowerCase(),
            input: ESCROW_AUTH_INPUT,
          };
        },
        async getTxFacts(txHash) {
          const tid = txToTrade.get(txHash.toLowerCase());
          if (!tid) return "not_found";
          return {
            from: baseLeg.payer,
            to: "0xf96815976523e00e65be8f34ca5e64b4f41eb19c",
            status: "success",
            input: "0x",
          };
        },
        async getLatestBlockTimestamp() {
          return Math.floor(Date.now() / 1000);
        },
        async paymentTxPaysTo() {
          return true;
        },
      }),
    );

    setTradeDisputeStoreForTests(
      memoryTradeDisputeStore([
        disputeLeg({
          tradeId: tOk,
          side: "seller",
          payer: baseLeg.payer,
          receiver: baseLeg.receiver,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          acceptedAt: baseLeg.acceptedAt,
          deliveredBodySha256: bodyHash,
          commitment: "c1".repeat(32),
          paymentTx: "0x" + "4".repeat(64),
        }),
        disputeLeg({
          tradeId: tOk,
          side: "payer",
          payer: baseLeg.payer,
          receiver: baseLeg.receiver,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          acceptedAt: baseLeg.acceptedAt,
          receivedBodySha256: bodyHash,
          commitment: "c2".repeat(32),
          paymentTx: "0x" + "4".repeat(64),
        }),
        disputeLeg({
          tradeId: tOther,
          side: "payer",
          payer: baseLeg.payer,
          receiver: OTHER,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          acceptedAt: baseLeg.acceptedAt,
          commitment: "c3".repeat(32),
          paymentTx: "0x" + "5".repeat(64),
        }),
        disputeLeg({
          tradeId: tDispute,
          side: "seller",
          payer: baseLeg.payer,
          receiver: baseLeg.receiver,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          acceptedAt: baseLeg.acceptedAt,
          commitment: "c4".repeat(32),
          paymentTx: "0x" + "6".repeat(64),
        }),
        disputeLeg({
          tradeId: tDispute,
          side: "payer",
          payer: baseLeg.payer,
          receiver: baseLeg.receiver,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          acceptedAt: baseLeg.acceptedAt,
          receivedBodySha256: bodyHash,
          commitment: "c5".repeat(32),
          paymentTx: "0x" + "6".repeat(64),
        }),
      ]),
    );
    try {
      let raw = await fetchSellerOpsFromDb(SELLER);
      assert.equal(raw.disputes.recordsPresent, 2);
      assert.equal(raw.disputes.disputeCount, 2);
      let card = buildSellerCard(raw);
      assert.equal(card.disputes.state, "has_data");
    } finally {
      setTradeDisputeStoreForTests(null);
      setE6ChainReaderForTests(null);
    }
  });

  test("[p2d] ops seller dispute count with bilateral claims", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchSellerOpsFromDb } = await import("@/lib/dashboard/ops-data");
    const { memoryTradeDisputeStore, setTradeDisputeStoreForTests } = await import(
      "@/lib/observatory/trade-dispute-store"
    );
    const { setE6ChainReaderForTests } = await import("@/lib/observatory/e6-chain-reader");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints RESTART IDENTITY CASCADE`);

    const SELLER = "0x4444444444444444444444444444444444444444";
    const op = "0x0000000000000000000000000000000000000def";
    const tradeId = "0x" + "7".repeat(64);
    const bodyHash = "b".repeat(64);
    const payTx = "0x" + "8".repeat(64);
    const baseLeg = {
      chain: "eip155:84532",
      payer: "0x0000000000000000000000000000000000000ddd",
      receiver: SELLER,
      paymentInfoOperator: op,
      acceptedAt: "2026-06-02T12:00:00.000Z",
    };

    setE6ChainReaderForTests(null);
    setTradeDisputeStoreForTests(
      memoryTradeDisputeStore([
        disputeLeg({
          tradeId,
          side: "seller",
          payer: baseLeg.payer,
          receiver: baseLeg.receiver,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          commitment: "f1".repeat(32),
          paymentTx: payTx,
          acceptedAt: baseLeg.acceptedAt,
        }),
        disputeLeg({
          tradeId,
          side: "payer",
          payer: baseLeg.payer,
          receiver: baseLeg.receiver,
          paymentInfoOperator: baseLeg.paymentInfoOperator,
          receivedBodySha256: bodyHash,
          commitment: "f2".repeat(32),
          paymentTx: payTx,
          acceptedAt: baseLeg.acceptedAt,
        }),
      ]),
    );
    try {
      const raw = await fetchSellerOpsFromDb(SELLER);
      assert.equal(raw.disputes.recordsPresent, 1);
      assert.equal(raw.disputes.disputeCount, 1);
    } finally {
      setTradeDisputeStoreForTests(null);
      setE6ChainReaderForTests(null);
    }
  });

  test("[p2d] ops seller dispute counting capped at dispute purchase limit", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchSellerOpsFromDb, setDisputePurchaseLimitForTests } = await import(
      "@/lib/dashboard/ops-data"
    );
    const { memoryTradeDisputeStore, setTradeDisputeStoreForTests } = await import(
      "@/lib/observatory/trade-dispute-store"
    );
    const { setE6ChainReaderForTests } = await import("@/lib/observatory/e6-chain-reader");

    setE6ChainReaderForTests(
      mergeReader({
        async readPaymentState() {
          return { collected: true, capturable: "1", refundable: "0" };
        },
      async getPaymentInfoHash() {
        return "0x" + "1".repeat(64);
      },
      async getEscrowCall() {
        return "rejected";
      },
      async getTxFacts() {
        return "not_found";
      },
      async getLatestBlockTimestamp() {
        return Math.floor(Date.now() / 1000);
      },
      async paymentTxPaysTo() {
        return true;
      },
      }),
    );

    const SELLER = "0x5555555555555555555555555555555555555555";
    const op = "0x0000000000000000000000000000000000000fed";
    const legs: TradeDisputeLegRow[] = [];
    for (let i = 0; i < 5; i++) {
      const tradeId = `0x${(i + 1).toString(16).padStart(64, "0")}`;
      const payTx = `0x${(i + 0x11).toString(16).padStart(64, "0")}`;
      const acceptedAt = `2026-06-0${i + 1}T12:00:00.000Z`;
      const shared = {
        payer: "0x0000000000000000000000000000000000000ccc",
        receiver: SELLER,
        paymentInfoOperator: op,
        acceptedAt,
      };
      legs.push(
        disputeLeg({
          tradeId,
          side: "seller",
          ...shared,
          deliveredBodySha256: "c".repeat(64),
          commitment: `s${i}`.repeat(16),
          paymentTx: payTx,
        }),
        disputeLeg({
          tradeId,
          side: "payer",
          ...shared,
          receivedBodySha256: "d".repeat(64),
          commitment: `p${i}`.repeat(16),
          paymentTx: payTx,
        }),
      );
    }

    setDisputePurchaseLimitForTests(2);
    setTradeDisputeStoreForTests(memoryTradeDisputeStore(legs));
    try {
      const raw = await fetchSellerOpsFromDb(SELLER);
      assert.equal(raw.disputes.recordsPresent, 2);
      assert.equal(raw.disputes.disputeCount, 2);
    } finally {
      setDisputePurchaseLimitForTests(null);
      setTradeDisputeStoreForTests(null);
      setE6ChainReaderForTests(null);
    }
  });

  test("seller dispute purchase limit counts latest purchases only", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { fetchSellerOpsFromDb, setDisputePurchaseLimitForTests } = await import(
      "@/lib/dashboard/ops-data"
    );
    const { memoryTradeDisputeStore, setTradeDisputeStoreForTests } = await import(
      "@/lib/observatory/trade-dispute-store"
    );
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints RESTART IDENTITY CASCADE`);

    const WALLET = "0x1111111111111111111111111111111111111111";
    const URL = "https://limit-test.example/api";
    const epInsert = (await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                  canonical_url, resource_id, endpoint_hash, payee_id, status)
      VALUES ('limit-test', ${URL}, 'GET', 'eip155:8453', ${WALLET}, '1000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              ${URL}, ${resourceId("GET", URL)}, ${endpointHash(URL)}, ${payeeId("eip155:8453", WALLET)}, 'active')
      RETURNING id::text AS id
    `)) as { rows?: { id: string }[] } | { id: string }[];
    const endpointId = (Array.isArray(epInsert) ? epInsert[0] : epInsert.rows?.[0])!.id;

    const purchaseIds: string[] = [];
    for (const at of ["2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z", "2026-02-03T00:00:00Z"] as const) {
      const row = (await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, pay_to, amount_units, spent_units, payer, attempted_at)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', ${WALLET}, '1', '1', '0xabc', ${at}::timestamptz)
        RETURNING id::text AS id
      `)) as { rows?: { id: string }[] } | { id: string }[];
      purchaseIds.push((Array.isArray(row) ? row[0] : row.rows?.[0])!.id);
    }
    const oldestId = purchaseIds[0]!;

    setDisputePurchaseLimitForTests(2);
    try {
      let out = await fetchSellerOpsFromDb(WALLET);
      assert.equal(out.disputes.purchaseIdsChecked, 2);
      assert.equal(out.disputes.truncated, true);

      const op = "0x0000000000000000000000000000000000000def";
      setTradeDisputeStoreForTests(
        memoryTradeDisputeStore([
          disputeLeg({
            tradeId: "0x" + "9".repeat(64),
            side: "seller",
            payer: "0x0000000000000000000000000000000000000ddd",
            receiver: WALLET,
            paymentInfoOperator: op,
            commitment: "e1".repeat(32),
            paymentTx: "0x" + "9".repeat(64),
            acceptedAt: "2026-02-01T00:00:00.000Z",
          }),
        ]),
      );

      out = await fetchSellerOpsFromDb(WALLET);
      assert.equal(out.disputes.recordsPresent, 1);
      assert.equal(out.disputes.truncated, true);

      setDisputePurchaseLimitForTests(3);
      out = await fetchSellerOpsFromDb(WALLET);
      assert.equal(out.disputes.truncated, false);
      assert.equal(out.disputes.purchaseIdsChecked, 3);
      assert.equal(out.disputes.recordsPresent, 1);
    } finally {
      setDisputePurchaseLimitForTests(null);
      setTradeDisputeStoreForTests(null);
    }
  });
}
