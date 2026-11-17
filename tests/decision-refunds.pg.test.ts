import assert from "node:assert/strict";
import { before, test } from "node:test";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision refunds (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const HOST = "j4decision.example";
  const PAY_TO = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0j4";
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SELLER_ROW_META = { requestBody: "declared", requestQuery: "empty" } as const;
  const SELLER_ROW_SCHEMA = { properties: { input: { properties: {} } } } as const;

  async function removeOwnRows() {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    const key = `${HOST}/%`;
    await db.execute(sql`DELETE FROM x402_l1_purchases WHERE endpoint_id IN (SELECT id FROM x402_endpoints WHERE resource_key LIKE ${key})`);
    await db.execute(sql`DELETE FROM x402_endpoints WHERE resource_key LIKE ${key}`);
    await db.execute(sql`DELETE FROM x402_payer_refund_transfers WHERE from_address = ${PAY_TO.toLowerCase()}`);
  }

  async function seedSellerFailureDays(
    db: NonNullable<Awaited<ReturnType<typeof import("@/lib/db/client").getDb>>>,
    schema: typeof import("@/lib/db/schema"),
    endpointId: string,
    payer: string,
    payTo: string,
  ) {
    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId,
        status: "settled",
        network: "eip155:8453",
        payer,
        payTo,
        asset: BASE_USDC,
        rawResponseMeta: SELLER_ROW_META,
        amountUnits: "100",
        httpStatusPaid: 500,
        payloadNonEmpty: true,
        txHash: `0xseed${endpointId.replace(/-/g, "").slice(0, 10)}aaaaaaaaaaaaaaaaaaaaaaaaaaa1`,
        spentUnits: "100",
        attemptedAt: new Date("2026-09-10T00:00:00Z"),
      },
      {
        endpointId,
        status: "settled",
        network: "eip155:8453",
        payer,
        payTo,
        asset: BASE_USDC,
        rawResponseMeta: SELLER_ROW_META,
        amountUnits: "100",
        httpStatusPaid: 500,
        payloadNonEmpty: true,
        txHash: `0xseed${endpointId.replace(/-/g, "").slice(0, 10)}aaaaaaaaaaaaaaaaaaaaaaaaaaa2`,
        spentUnits: "100",
        attemptedAt: new Date("2026-09-15T00:00:00Z"),
      },
    ]);
  }

  before(removeOwnRows);

  test("decide() reads host refund totals and emits seller_refunded_failures at 50%", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { decide, invalidateDecisionCache } = await import("@/lib/decision/decide");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { SELLER_REFUNDED_FAILURES } = await import("@/lib/decision/seller-refunds");
    const payer = BASE_PAYER_PERIODS[1]!.address.toLowerCase();
    const db = getDb()!;

    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `${HOST}/api`,
        resourceUrl: `https://${HOST}/api`,
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
        declaredSchema: SELLER_ROW_SCHEMA,
        payTo: PAY_TO,
      })
      .returning();

    for (const h of [1, 2]) {
      await db.insert(schema.x402L0Probes).values({
        endpointId: ep.id,
        method: "GET",
        verdict: "pass",
        probedAt: new Date("2026-11-10T12:00:00Z"),
      });
    }

    await seedSellerFailureDays(db, schema, ep.id, payer, PAY_TO);
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      asset: BASE_USDC,
      rawResponseMeta: SELLER_ROW_META,
      amountUnits: "1000",
      httpStatusPaid: 500,
      payloadNonEmpty: true,
      spentUnits: "1000",
      attemptedAt: new Date("2026-10-01T00:00:00Z"),
      txHash: "0xmainrefund0000000000000000000000000000000001",
    });

    await db.insert(schema.x402PayerRefundTransfers).values({
      chain: "eip155:8453",
      txHash: "0xrefundj400000000000000000000000000000000001",
      logIndex: 0,
      fromAddress: PAY_TO.toLowerCase(),
      toAddress: payer,
      asset: BASE_USDC,
      amount: "600",
      blockNumber: 100n,
      blockTime: new Date("2026-10-05T00:00:00Z"),
    });

    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } = await import("@/lib/chain/block-clock");
    const readBlock = firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, Math.floor(Date.parse("2026-11-02T00:00:00.000Z") / 1000));
    await setIndexerCheckpoint("payer_refunds:eip155:8453", readBlock);

    invalidateDecisionCache();
    const d = await decide({ role: "payer", observatoryId: ep.id, operatorBlacklist: false, skipScore: true });
    assert.ok(d);
    assert.ok(d.refunds);
    assert.equal(d.refunds.paid_units, "1200");
    assert.equal(d.refunds?.refunded_units, "600");
    assert.equal(d.refunds?.refund_rate, 0.5);
    assert.ok(d.reason_codes.includes(SELLER_REFUNDED_FAILURES));

    await removeOwnRows();
  });
}