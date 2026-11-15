import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Address } from "viem";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("seller refund index (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";
  const REFILL = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeed0001";
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SELLER_ROW_META = { requestBody: "declared", requestQuery: "empty" } as const;
  const SELLER_ROW_SCHEMA = { properties: { input: { properties: {} } } } as const;
  const TIP = 1_000_000n;
  const BLOCK_TS = Math.floor(new Date("2026-10-05T00:00:00.000Z").getTime() / 1000);

  type FakeLog = {
    transactionHash: string;
    logIndex: number;
    blockNumber: bigint;
    args: { from: Address; to: Address; value: bigint };
  };

  function makeClient(logs: FakeLog[]) {
    return {
      getBlockNumber: async () => TIP,
      getBlock: async () => ({
        timestamp: BigInt(BLOCK_TS),
      }),
      getLogs: async (params: { fromBlock?: bigint; toBlock?: bigint; args?: { to?: Address[] } }) => {
        const from = params.fromBlock ?? 0n;
        const to = params.toBlock ?? TIP;
        const dest = new Set((params.args?.to ?? []).map((a) => a.toLowerCase()));
        return logs.filter(
          (l) => l.blockNumber >= from && l.blockNumber <= to && dest.has(l.args.to.toLowerCase()),
        );
      },
    };
  }


  /** この試験が入れた行だけを消す（出品の resource_key の host で絞る・返金の表と checkpoint は返金の試験の持ち物）。 */
  async function removeOwnRows(hosts: readonly string[]) {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    const keys = sql.join(hosts.map((h) => sql`${`${h}/%`}::text`), sql`, `);
    await db.execute(sql`DELETE FROM x402_l1_purchases WHERE endpoint_id IN (SELECT id FROM x402_endpoints WHERE resource_key LIKE ANY (ARRAY[${keys}]))`);
    await db.execute(sql`DELETE FROM x402_endpoints WHERE resource_key LIKE ANY (ARRAY[${keys}])`);
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await db.execute(sql`DELETE FROM x402_payer_refund_transfers`);
  }

  const OWN_HOSTS = ["refund.example", "chk.example", "deadline.example", "insert.example", "bigint.example", "midscan.example", "hosta.example", "hostb.example", "operator.example", "orskip.example", "missing.example"] as const;

  before(async () => {
    await removeOwnRows(OWN_HOSTS);
  });

  test("indexPayerRefunds stores payTo refunds only and is idempotent", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const payer = BASE_PAYER_PERIODS[1]!.address.toLowerCase();

    const db = getDb()!;
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "refund.example/a",
        resourceUrl: "https://refund.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
        declaredSchema: SELLER_ROW_SCHEMA,
      })
      .returning();
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
      spentUnits: "1000",
      attemptedAt: new Date("2026-10-01T00:00:00Z"),
      txHash: "0xmainrefund0000000000000000000000000000000001",
    });

    const logs: FakeLog[] = [
      {
        transactionHash: "0xaaa",
        logIndex: 0,
        blockNumber: 100n,
        args: { from: PAY_TO as Address, to: payer as Address, value: 1000n },
      },
      {
        transactionHash: "0xbbb",
        logIndex: 0,
        blockNumber: 101n,
        args: { from: REFILL as Address, to: payer as Address, value: 1000n },
      },
    ];
    const client = makeClient(logs);
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 99n);

    const first = await indexPayerRefunds({
      db,
      client: client as never,
      maxBlocksPerRun: 200n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(first.stored, 1);
    assert.ok(first.checkpoint);

    const second = await indexPayerRefunds({
      db,
      client: client as never,
      maxBlocksPerRun: 200n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(second.stored, 0);

    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM x402_payer_refund_transfers`);
    const raw = rows as unknown as { rows?: { n: number }[] } | { n: number }[];
    const n = Array.isArray(raw) ? raw[0]?.n : raw.rows?.[0]?.n;
    assert.equal(n, 1);

    const { readSellerRefundStats } = await import("@/lib/sellers/refund-reader");
    // Before the 30-day window is read, the purchase is not in the count.
    const open = await readSellerRefundStats(db, { host: "refund.example" });
    assert.ok(open);
    assert.equal(open!.pay_tos.length, 1);
    assert.equal(open!.pay_tos[0]!.paid_units, "0");
    assert.equal(open!.pay_tos[0]!.failures_window_open, 3);
    assert.equal(open!.pay_tos[0]!.refund_rate, null);
    // Move read_through past 2026-10-01 (purchase + 30 days) so the purchase counts.
    const { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } = await import("@/lib/chain/block-clock");
    const readBlock = firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, Math.floor(Date.parse("2026-11-02T00:00:00.000Z") / 1000));
    await setIndexerCheckpoint("payer_refunds:eip155:8453", readBlock);
    const byHost = await readSellerRefundStats(db, { host: "refund.example" });
    assert.ok(byHost);
    const row = byHost!.pay_tos[0]!;
    assert.equal(row.failures_counted, 3);
    assert.equal(row.paid_units, "1200");
    assert.equal(row.refunded_units, "1000");
    assert.equal(row.refund_rate, 0.8333);
    assert.equal(row.refund_transfers, 1);
    const byPayTo = await readSellerRefundStats(db, { payTo: PAY_TO });
    assert.deepEqual(byPayTo!.pay_tos, byHost!.pay_tos);
  });

  test("indexPayerRefunds leaves checkpoint when getLogs throws", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { getIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "chk.example/a",
        resourceUrl: "https://chk.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 50n);
    const client = {
      getBlockNumber: async () => TIP,
      getBlock: async () => ({ timestamp: BigInt(BLOCK_TS) }),
      getLogs: async () => {
        throw new Error("getLogs failed");
      },
    };
    await assert.rejects(
      () =>
        indexPayerRefunds({
          db,
          client: client as never,
          maxBlocksPerRun: 10n,
          budgetMs: 60_000,
          now: () => 0,
        }),
      /getLogs failed/,
    );
    assert.equal(await getIndexerCheckpoint("payer_refunds:eip155:8453"), 50n);
  });

  test("indexPayerRefunds leaves checkpoint when deadline is exceeded", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { getIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const { DeadlineExceededError } = await import("@/lib/util/deadline");
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "deadline.example/a",
        resourceUrl: "https://deadline.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 60n);
    const client = {
      getBlockNumber: async () => TIP,
      getBlock: async () => ({ timestamp: BigInt(BLOCK_TS) }),
      getLogs: async () => [],
    };
    const getLogs = async () => {
      throw new DeadlineExceededError("deadline", 5_000);
    };
    const result = await indexPayerRefunds({
      db,
      client: client as never,
      getLogs: getLogs as never,
      maxBlocksPerRun: 10n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(result.cutOff, true);
    assert.equal(await getIndexerCheckpoint("payer_refunds:eip155:8453"), 60n);
  });

  test("indexPayerRefunds leaves checkpoint when insert throws", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { getIndexerCheckpoint, setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "insert.example/a",
        resourceUrl: "https://insert.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 70n);
    const logs: FakeLog[] = [
      {
        transactionHash: "0xinsertfail",
        logIndex: 0,
        blockNumber: 80n,
        args: { from: PAY_TO as Address, to: payer as Address, value: 500n },
      },
    ];
    const client = makeClient(logs);
    let insertCalled = false;
    const failingDb = {
      execute: (query: unknown) => db.execute(query as never),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              insertCalled = true;
              throw new Error("insert failed");
            },
          }),
        }),
      }),
    };

    await assert.rejects(
      () =>
        indexPayerRefunds({
          db: failingDb as never,
          client: client as never,
          maxBlocksPerRun: 20n,
          budgetMs: 60_000,
          now: () => 0,
        }),
      /insert failed/,
    );
    assert.equal(insertCalled, true);
    assert.equal(await getIndexerCheckpoint("payer_refunds:eip155:8453"), 70n);
  });

  test("indexPayerRefunds leaves checkpoint when log value is not bigint", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { getIndexerCheckpoint, setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "bigint.example/a",
        resourceUrl: "https://bigint.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 90n);
    const client = makeClient([
      {
        transactionHash: "0xbadvalue",
        logIndex: 0,
        blockNumber: 95n,
        args: { from: PAY_TO as Address, to: payer as Address, value: undefined as unknown as bigint },
      },
    ]);
    const result = await indexPayerRefunds({
      db,
      client: client as never,
      maxBlocksPerRun: 20n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(result.stored, 0);
    assert.equal(await getIndexerCheckpoint("payer_refunds:eip155:8453"), 90n);
  });

  test("indexPayerRefunds picks up payTo added during the first getLogs call", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const NEW_PAY_TO = "0xcafe000000000000000000000000000000000001";
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "midscan.example/a",
        resourceUrl: "https://midscan.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 99n);
    const logs: FakeLog[] = [
      {
        transactionHash: "0xnewpayto",
        logIndex: 0,
        blockNumber: 110n,
        args: { from: NEW_PAY_TO as Address, to: payer as Address, value: 800n },
      },
    ];
    const filter = makeClient(logs).getLogs;
    let firstSlice = true;
    const getLogs = async (
      _client: unknown,
      params: { fromBlock?: bigint; toBlock?: bigint; args?: { to?: Address[] } },
    ) => {
      if (firstSlice) {
        firstSlice = false;
        const [ep2] = await db
          .insert(schema.x402Endpoints)
          .values({
            resourceKey: "midscan.example/b",
            resourceUrl: "https://midscan.example/b",
            network: "eip155:8453",
            method: "GET",
            status: "active",
            priceAmount: "800",
          })
          .returning();
        await db.insert(schema.x402L1Purchases).values({
          endpointId: ep2.id,
          status: "settled",
          network: "eip155:8453",
          payer,
          payTo: NEW_PAY_TO,
          amountUnits: "800",
          httpStatusPaid: 500,
          spentUnits: "800",
          attemptedAt: new Date("2026-09-01T00:00:00Z"),
        });
      }
      return filter(params as never);
    };
    const client = makeClient(logs);
    const result = await indexPayerRefunds({
      db,
      client: client as never,
      getLogs: getLogs as never,
      maxBlocksPerRun: 200n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(result.stored, 1);
    const rows = await db.execute(sql`
      SELECT lower(from_address) AS from_address FROM x402_payer_refund_transfers
    `);
    const stored = rowsOf<{ from_address: string }>(rows).map((r) => r.from_address);
    assert.ok(stored.includes(NEW_PAY_TO.toLowerCase()));
  });

  function rowsOf<T>(raw: unknown): T[] {
    return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
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
        amountUnits: "100",
        asset: BASE_USDC,
        rawResponseMeta: SELLER_ROW_META,
        httpStatusPaid: 500,
        txHash: `0xseed${endpointId.replace(/-/g, "").slice(0, 10)}a`,
        spentUnits: "100",
        attemptedAt: new Date("2026-09-10T00:00:00Z"),
      },
      {
        endpointId,
        status: "settled",
        network: "eip155:8453",
        payer,
        payTo,
        amountUnits: "100",
        asset: BASE_USDC,
        rawResponseMeta: SELLER_ROW_META,
        httpStatusPaid: 500,
        txHash: `0xseed${endpointId.replace(/-/g, "").slice(0, 10)}b`,
        spentUnits: "100",
        attemptedAt: new Date("2026-09-15T00:00:00Z"),
      },
    ]);
  }

  test("readSellerRefundStats counts one refund across two hosts sharing payTo", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { readSellerRefundStats } = await import("@/lib/sellers/refund-reader");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } = await import("@/lib/chain/block-clock");
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const payer = BASE_PAYER_PERIODS[1]!.address.toLowerCase();
    const SHARED = "0xbeef000000000000000000000000000000000001";
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [epA] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "hosta.example/a",
        resourceUrl: "https://hosta.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
        declaredSchema: SELLER_ROW_SCHEMA,
      })
      .returning();
    const [epB] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "hostb.example/a",
        resourceUrl: "https://hostb.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
        declaredSchema: SELLER_ROW_SCHEMA,
      })
      .returning();
    const attempted = new Date("2026-10-01T00:00:00Z");
    await seedSellerFailureDays(db, schema, epA.id, payer, SHARED);
    await seedSellerFailureDays(db, schema, epB.id, payer, SHARED);
    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: epA.id,
        status: "settled",
        network: "eip155:8453",
        payer,
        payTo: SHARED,
        asset: BASE_USDC,
        rawResponseMeta: SELLER_ROW_META,
        amountUnits: "1000",
        httpStatusPaid: 500,
        spentUnits: "1000",
        attemptedAt: attempted,
        txHash: "0xhostamain000000000000000000000000000000001",
      },
      {
        endpointId: epB.id,
        status: "settled",
        network: "eip155:8453",
        payer,
        payTo: SHARED,
        asset: BASE_USDC,
        rawResponseMeta: SELLER_ROW_META,
        amountUnits: "1000",
        httpStatusPaid: 500,
        spentUnits: "1000",
        attemptedAt: attempted,
        txHash: "0xhostbmain000000000000000000000000000000001",
      },
    ]);
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 99n);
    const logs: FakeLog[] = [
      {
        transactionHash: "0xsharedrefund",
        logIndex: 0,
        blockNumber: 120n,
        args: { from: SHARED as Address, to: payer as Address, value: 1000n },
      },
    ];
    const indexed = await indexPayerRefunds({
      db,
      client: makeClient(logs) as never,
      maxBlocksPerRun: 200n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(indexed.stored, 1);
    const readBlock = firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, Math.floor(Date.parse("2026-11-02T00:00:00.000Z") / 1000));
    await setIndexerCheckpoint("payer_refunds:eip155:8453", readBlock);
    const statsA = await readSellerRefundStats(db, { host: "hosta.example" });
    const statsB = await readSellerRefundStats(db, { host: "hostb.example" });
    assert.ok(statsA);
    assert.ok(statsB);
    // Both pages show the same payTo-level number and say the payTo is shared. No split per host.
    assert.deepEqual(statsA!.pay_tos, statsB!.pay_tos);
    assert.equal(statsA!.pay_tos.length, 1);
    assert.equal(statsA!.pay_tos[0]!.listings_sharing, 2);
    assert.equal(statsA!.pay_tos[0]!.refund_transfers, 1);
    const { payToRefundLines } = await import("@/components/site/sellers/SellerRefundSection");
    for (const st of [statsA!, statsB!]) {
      const r = st.pay_tos[0]!;
      assert.ok(BigInt(r.paid_units) > 0n, "paid is in the count");
      assert.equal(r.refunded_units, "1000");
      const lines = payToRefundLines(r);
      assert.ok(lines[0]!.includes("is shared by 2 listings"), lines[0]);
      assert.ok(lines[0]!.includes("for the payTo as a whole"), lines[0]);
    }
  });

  test("indexPayerRefunds skips operator payTo and reader does not count it", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { readSellerRefundStats } = await import("@/lib/sellers/refund-reader");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const OPERATOR = "0xoperator00000000000000000000000000000001";
    const prev = process.env.VET402_OPERATOR_PAYTO;
    process.env.VET402_OPERATOR_PAYTO = OPERATOR;
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
  try {
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "operator.example/a",
        resourceUrl: "https://operator.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await seedSellerFailureDays(db, schema, ep.id, payer, OPERATOR);
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: OPERATOR,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 99n);
    const logs: FakeLog[] = [
      {
        transactionHash: "0xoperatorrefund",
        logIndex: 0,
        blockNumber: 100n,
        args: { from: OPERATOR as Address, to: payer as Address, value: 1000n },
      },
    ];
    const indexed = await indexPayerRefunds({
      db,
      client: makeClient(logs) as never,
      maxBlocksPerRun: 200n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(indexed.stored, 0);
    const { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } = await import("@/lib/chain/block-clock");
    const readBlock = firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, Math.floor(Date.parse("2026-10-02T00:00:00Z") / 1000));
    await setIndexerCheckpoint("payer_refunds:eip155:8453", readBlock);
    const stats = await readSellerRefundStats(db, { host: "operator.example" });
    assert.ok(stats);
    assert.equal(stats!.pay_tos.length, 0);
  } finally {
    if (prev === undefined) delete process.env.VET402_OPERATOR_PAYTO;
    else process.env.VET402_OPERATOR_PAYTO = prev;
  }
  });

  test("indexPayerRefundsOrSkip returns skipped when the refund table is missing", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { indexPayerRefundsOrSkip } = await import("@/lib/sellers/refund-index");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { getIndexerCheckpoint, setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
    const db = getDb()!;
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = 'payer_refunds:eip155:8453'`);
    await removeOwnRows(OWN_HOSTS);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "orskip.example/a",
        resourceUrl: "https://orskip.example/a",
        network: "eip155:8453",
        method: "GET",
        status: "active",
        priceAmount: "1000",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      network: "eip155:8453",
      payer,
      payTo: PAY_TO,
      amountUnits: "1000",
      httpStatusPaid: 500,
      spentUnits: "1000",
      attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 40n);
    await db.execute(sql`DROP TABLE IF EXISTS x402_payer_refund_transfers CASCADE`);
    const logs: FakeLog[] = [
      {
        transactionHash: "0xorskip",
        logIndex: 0,
        blockNumber: 50n,
        args: { from: PAY_TO as Address, to: payer as Address, value: 1000n },
      },
    ];
    const result = await indexPayerRefundsOrSkip({
      db,
      client: makeClient(logs) as never,
      maxBlocksPerRun: 20n,
      budgetMs: 60_000,
      now: () => 0,
    });
    assert.equal(result.skipped, "table_missing");
    assert.equal(await getIndexerCheckpoint("payer_refunds:eip155:8453"), 40n);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS x402_payer_refund_transfers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        chain text NOT NULL,
        tx_hash text NOT NULL,
        log_index integer NOT NULL,
        from_address text NOT NULL,
        to_address text NOT NULL,
        asset text NOT NULL,
        amount text NOT NULL,
        block_number bigint NOT NULL,
        block_time timestamptz NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS x402_payer_refund_transfers_chain_tx_log_idx
        ON x402_payer_refund_transfers (chain, tx_hash, log_index)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS x402_payer_refund_transfers_from_address_idx
        ON x402_payer_refund_transfers (from_address)
    `);
  });

  test("readSellerRefundStats returns null when the table is missing", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    const schema = await import("@/lib/db/schema");
    // Give the host a settled purchase so the reader reaches the refund table.
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "missing.example/a", resourceUrl: "https://missing.example/a", network: "eip155:8453", method: "GET", status: "active", priceAmount: "1000" })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id, status: "settled", network: "eip155:8453", payer: "0x1111111111111111111111111111111111111111",
      payTo: PAY_TO, amountUnits: "1000", httpStatusPaid: 500, spentUnits: "1000", attemptedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await db.execute(sql`DROP TABLE IF EXISTS x402_payer_refund_transfers CASCADE`);
    const { readSellerRefundStats } = await import("@/lib/sellers/refund-reader");
    assert.equal(await readSellerRefundStats(db, { host: "missing.example" }), null);
  });

  after(async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS x402_payer_refund_transfers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        chain text NOT NULL,
        tx_hash text NOT NULL,
        log_index integer NOT NULL,
        from_address text NOT NULL,
        to_address text NOT NULL,
        asset text NOT NULL,
        amount text NOT NULL,
        block_number bigint NOT NULL,
        block_time timestamptz NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS x402_payer_refund_transfers_chain_tx_log_idx
        ON x402_payer_refund_transfers (chain, tx_hash, log_index)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS x402_payer_refund_transfers_from_address_idx
        ON x402_payer_refund_transfers (from_address)
    `);
    await removeOwnRows(OWN_HOSTS);
  });
}