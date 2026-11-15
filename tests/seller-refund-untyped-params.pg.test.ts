// 返金の索引と読み取りの生の SQL を、型の無い引数で流す（2026-11-16 wave2 u4j4）。
//
// なぜ: 本番の neon-http は引数を型の無い文字列として送る。postgres-js の試験は引数に型を付けて送るので、
// `$1` の型を文脈から決められない SQL（例: (VALUES ($1,$2)) と非 text の列の比較）は試験では通り、本番では 42804 で落ちる。
// ここでは db.execute に渡る SQL を全部 PREPARE（引数の型を指定しない）＋ EXECUTE（引数は型の無い文字列の定数）で流し直す。
// Postgres は PREPARE の引数の型を文脈から推すので、neon-http と同じ条件になる。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Address } from "viem";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("seller refund untyped params (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0099";
  let seq = 0;

  function literal(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    const s = typeof v === "string" ? v : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `'${s.replace(/'/g, "''")}'`;
  }

  /** db の execute だけを、型の無い引数の PREPARE / EXECUTE に差し替えた写し。 */
  async function untypedDb() {
    const { getDb } = await import("@/lib/db/client");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const dialect = new PgDialect();
    const seen: string[] = [];
    const execute = async (q: Parameters<typeof db.execute>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(q as never);
      seen.push(text);
      if (params.length === 0) return db.execute(sql.raw(text));
      const name = `u4j4_untyped_${++seq}`;
      await db.execute(sql.raw(`PREPARE ${name} AS ${text}`));
      try {
        return await db.execute(sql.raw(`EXECUTE ${name}(${params.map(literal).join(", ")})`));
      } finally {
        await db.execute(sql.raw(`DEALLOCATE ${name}`));
      }
    };
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") return execute;
        return Reflect.get(target, prop, receiver);
      },
    });
    return { db: proxy as typeof db, seen };
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

  before(async () => {
    await removeOwnRows(["untyped.example"]);
  });

  after(async () => {
    await removeOwnRows(["untyped.example"]);
  });

  test("the refund index and the refund reader run with untyped parameters", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { BASE_PAYER_PERIODS } = await import("@/lib/sellers/payers");
    const { indexPayerRefunds } = await import("@/lib/sellers/refund-index");
    const { readSellerRefundStats, readPayToRefundStats } = await import("@/lib/sellers/refund-reader");
    const real = getDb()!;
    const payer = BASE_PAYER_PERIODS[0]!.address.toLowerCase();

    const [ep] = await real
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "untyped.example/a", resourceUrl: "https://untyped.example/a", network: "eip155:8453", method: "GET", status: "active", priceAmount: "1000" })
      .returning();
    await real.insert(schema.x402L1Purchases).values({
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

    const { db, seen } = await untypedDb();
    const logs = [
      { transactionHash: "0xuntyped1", logIndex: 0, blockNumber: 100n, args: { from: PAY_TO as Address, to: payer as Address, value: 1000n } },
    ];
    const client = {
      getBlockNumber: async () => 1_000_000n,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.parse("2026-09-02T00:00:00Z") / 1000)) }),
      getLogs: async (params: { fromBlock?: bigint; toBlock?: bigint }) =>
        logs.filter((l) => l.blockNumber >= (params.fromBlock ?? 0n) && l.blockNumber <= (params.toBlock ?? 0n)),
    };
    const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
    await setIndexerCheckpoint("payer_refunds:eip155:8453", 99n);
    const summary = await indexPayerRefunds({ db, client: client as never, maxBlocksPerRun: 200n, budgetMs: 60_000, now: () => 0 });
    assert.equal(summary.stored, 1);

    const byHost = await readSellerRefundStats(db, { host: "untyped.example" });
    assert.ok(byHost, "the host read returns stats");
    assert.equal(byHost!.pay_tos.length, 1, "the payTo of the host is in the stats");
    const byPayTo = await readPayToRefundStats(db, PAY_TO);
    assert.ok(byPayTo, "the payTo read returns stats");
    // Every raw statement the two paths sent went through PREPARE without parameter types.
    assert.ok(seen.length >= 4, `raw statements seen: ${seen.length}`);
    assert.ok(seen.some((s) => s.includes("x402_payer_refund_transfers")), "the refund table read ran untyped");
  });
}
