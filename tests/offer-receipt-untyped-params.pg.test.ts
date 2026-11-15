// 購入の結果の UPDATE を、型の無い引数で流す（2026-11-16 wave2 receipt）。
//
// なぜ: 本番の neon-http は引数を型の無い文字列として送る。raw_settlement に offerReceipt・offerReceiptCheck の鍵が
// 乗っても、書き込みは l1-runner の既存の db.update(x402L1Purchases).set(outcomeRow) の1文のままで、生 SQL も
// transaction も足していない。ここでは同じ drizzle の UPDATE を PREPARE（引数の型を指定しない）＋ EXECUTE
// （引数は型の無い文字列の定数）で流し、jsonb の列が文脈から型を決めて通ることを固定する。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("offer receipt untyped params (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  function literal(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    const s = typeof v === "string" ? v : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `'${s.replace(/'/g, "''")}'`;
  }

  test("raw_settlement の offerReceipt と判定は、型の無い引数の UPDATE でもそのまま入る", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { eq, sql } = await import("drizzle-orm");
    const db = getDb()!;
    const dialect = new PgDialect();

    const endpointId = randomUUID();
    const [row] = await db
      .insert(schema.x402L1Purchases)
      .values({ endpointId, status: "in_flight" })
      .returning();
    try {
      const rawSettlement = {
        success: true,
        transaction: "0xdeadbeef000000000000000000000000000000000000000000000000000000b1",
        network: "eip155:8453",
        payer: "0xf39F",
        errorReason: null,
        offerReceipt: {
          info: {
            receipt: {
              format: "eip712",
              payload: { version: 1, network: "eip155:8453", resourceUrl: "https://seller.example/api?q=it's", payer: "0xf39F", issuedAt: 1703123456, transaction: "" },
              signature: `0x${"ab".repeat(65)}`,
            },
          },
        },
        offerReceiptCheck: { checkVersion: 1, receipt: "present", format: "eip712", signature: "recovered", signer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", resourceUrl: "match", payer: "match", network: "match", authorization: "not_checked" },
      };
      // l1-runner の結果の UPDATE と同じ形（jsonb 2列・text・integer・boolean）。
      const q = db
        .update(schema.x402L1Purchases)
        .set({
          status: "settle_claimed",
          txHash: rawSettlement.transaction,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          rawSettlement,
          rawResponseMeta: { phase: "paid" },
        })
        .where(eq(schema.x402L1Purchases.id, row.id));
      const { sql: text, params } = dialect.sqlToQuery(q.getSQL());
      assert.ok(params.length > 0);
      await db.execute(sql.raw(`PREPARE receipt_untyped_1 AS ${text}`));
      try {
        await db.execute(sql.raw(`EXECUTE receipt_untyped_1(${params.map(literal).join(", ")})`));
      } finally {
        await db.execute(sql.raw(`DEALLOCATE receipt_untyped_1`));
      }
      const [got] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, row.id));
      assert.equal(got.status, "settle_claimed");
      assert.equal(got.txHash, rawSettlement.transaction);
      assert.deepEqual(got.rawSettlement, rawSettlement);
    } finally {
      await db.delete(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, row.id));
    }
  });
}
