// Run: TEST_DATABASE_URL=... npm run test:db -- tests/answer-check.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("answer-check cron (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("answer-check cron writer", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { x402Endpoints, x402L1Purchases } = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { writeAnswerCheckMeta, runAnswerCheckCron } = await import("@/lib/observatory/answer-check/cron");
    const { readL1AnswerCheckStats } = await import("@/lib/observatory/answer-check/state-aggregate");
    const { getObservatoryStats } = await import("@/lib/observatory/reader");

    const db = getDb()!;
  await t.test("merge は他キーを残し、二回目は idempotent", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints CASCADE`);
      const [ep] = await db
        .insert(x402Endpoints)
        .values({
          resourceKey: "https://answer-check.example/api",
          resourceUrl: "https://answer-check.example/api",
          status: "active",
          declaredSchema: { properties: { output: { properties: { example: { required: ["x"] } } } } },
        })
        .returning();

      const [pu] = await db
        .insert(x402L1Purchases)
        .values({
          endpointId: ep!.id,
          status: "settled",
          spentUnits: "1000",
          httpStatusPaid: 200,
          l2Schema: "match",
          rawResponseMeta: {
            phase: "paid",
            bodyHead: '{"x":1}',
            bodyBytes: 7,
            contentType: "application/json",
            l2: { missing: [], reason: null },
          },
          challenge402: { x402Version: 2, accepts: [] },
        })
        .returning();

      const payload = {
        version: 2,
        checkedAt: "2026-11-17T00:00:00.000Z",
        checked: true,
        outcome: "match",
        checks: ["json_valid"],
        verdicts: [],
      };
      await writeAnswerCheckMeta(db, pu!.id, payload);

      const raw = await db.execute(sql`
        SELECT raw_response_meta FROM x402_l1_purchases WHERE id = ${pu!.id}::uuid
      `);
      const rows = Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows;
      const meta = (rows[0] as { raw_response_meta: Record<string, unknown> }).raw_response_meta;
      assert.equal(meta.phase, "paid");
      assert.equal((meta.answerCheck as Record<string, unknown>).outcome, "match");

      await writeAnswerCheckMeta(db, pu!.id, { ...payload, outcome: "mismatch" });
      const raw2 = await db.execute(sql`
        SELECT raw_response_meta->'answerCheck'->>'outcome' AS outcome FROM x402_l1_purchases WHERE id = ${pu!.id}::uuid
      `);
      const rows2 = Array.isArray(raw2) ? raw2 : (raw2 as { rows: unknown[] }).rows;
      assert.equal((rows2[0] as { outcome: string }).outcome, "match", "既存 answerCheck は上書きしない");
    });

    await t.test("cron が書いた行を state が数える", async () => {
      const stats = await readL1AnswerCheckStats(30);
      assert.equal(stats.settled, 1);
      assert.equal(stats.checked, 1);
      assert.equal(stats.match, 1);

      const obs = await getObservatoryStats();
      assert.deepEqual(obs.l1.answerCheck.match, 1);
      assert.equal(obs.l1.answerCheck.checkedShare, 1);
    });

    await t.test("runAnswerCheckCron は未処理行だけ処理する", async () => {
      const [pu2] = await db
        .insert(x402L1Purchases)
        .values({
          endpointId: (await db.select({ id: x402Endpoints.id }).from(x402Endpoints).limit(1))[0]!.id,
          status: "settled",
          spentUnits: "1000",
          httpStatusPaid: 200,
          l2Schema: "no_declaration",
          rawResponseMeta: {
            bodyHead: '{"y":2}',
            bodyBytes: 7,
            contentType: "application/json",
          },
          challenge402: {},
        })
        .returning();

      const first = await runAnswerCheckCron({ batchSize: 10, budgetMs: 30_000 });
      assert.equal(first.written, 1);
      const second = await runAnswerCheckCron({ batchSize: 10, budgetMs: 30_000 });
      assert.equal(second.written, 0);
      assert.equal(second.processed, 0);

      const raw = await db.execute(sql`
        SELECT raw_response_meta ? 'answerCheck' AS has FROM x402_l1_purchases WHERE id = ${pu2!.id}::uuid
      `);
      const rows = Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows;
      assert.equal((rows[0] as { has: boolean }).has, true);
    });

    await t.test("B4: 掲載の最古 complete JSON が基準・v1 を1回だけ上げる", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints CASCADE`);
      const [ep] = await db
        .insert(x402Endpoints)
        .values({
          resourceKey: "https://shape-baseline.example/api",
          resourceUrl: "https://shape-baseline.example/api",
          status: "active",
        })
        .returning();

      const mkPurchase = (body: string, daysAgo: number, l2: string | null) => ({
        endpointId: ep!.id,
        status: "settled" as const,
        spentUnits: "1000",
        httpStatusPaid: 200,
        l2Schema: l2,
        attemptedAt: new Date(Date.now() - daysAgo * 86_400_000),
        rawResponseMeta: {
          phase: "paid",
          bodyHead: body,
          bodyBytes: Buffer.byteLength(body),
          contentType: "application/json",
        },
        challenge402: {},
      });

      const [first] = await db.insert(x402L1Purchases).values(mkPurchase('{"k":1}', 10, "no_declaration")).returning();
      const [second] = await db
        .insert(x402L1Purchases)
        .values(mkPurchase('{"k":1,"extra":2}', 5, "no_declaration"))
        .returning();

      // 古い行に v1 を手書き（再処理対象）
      await db.execute(sql`
        UPDATE x402_l1_purchases
        SET raw_response_meta = raw_response_meta || jsonb_build_object('answerCheck', jsonb_build_object(
          'checked', true, 'outcome', 'unknown', 'reason', 'nothing_to_check', 'checks', '[]'::jsonb, 'verdicts', '[]'::jsonb
        ))
        WHERE id = ${second!.id}::uuid
      `);

      const up = await runAnswerCheckCron({ batchSize: 10, budgetMs: 30_000 });
      assert.equal(up.written, 2);

      const rawSecond = await db.execute(sql`
        SELECT raw_response_meta FROM x402_l1_purchases WHERE id = ${second!.id}::uuid
      `);
      const meta2 = (
        (Array.isArray(rawSecond) ? rawSecond : (rawSecond as { rows: unknown[] }).rows)[0] as {
          raw_response_meta: Record<string, unknown>;
        }
      ).raw_response_meta;
      assert.equal((meta2.answerCheck as Record<string, unknown>).version, 2);
      assert.equal((meta2.answerCheck as Record<string, unknown>).shapeBaseline, "same");
      assert.equal(meta2.phase, "paid");

      const rawFirst = await db.execute(sql`
        SELECT raw_response_meta->'answerCheck' AS ac FROM x402_l1_purchases WHERE id = ${first!.id}::uuid
      `);
      const ac1 = (
        (Array.isArray(rawFirst) ? rawFirst : (rawFirst as { rows: unknown[] }).rows)[0] as {
          ac: Record<string, unknown>;
        }
      ).ac;
      assert.equal(ac1.reason, "nothing_to_check");
      const shapeV = (ac1.verdicts as { check: string; reason: string }[]).find((v) => v.check === "shape_drift");
      assert.equal(shapeV?.reason, "baseline");

      const again = await runAnswerCheckCron({ batchSize: 10, budgetMs: 30_000 });
      assert.equal(again.written, 0);

      const stats = await readL1AnswerCheckStats(30);
      assert.ok(stats.checked >= 1);
      assert.ok(stats.shapeSame >= 1);
      assert.equal(stats.shapeChanged, 0);
    });

    // 2026-11-18 第三者点検: 最古の候補が使えない（壊れた JSON）とき、次に古い候補を基準にする。
    await t.test("B4: the oldest unusable candidate is skipped for the next one", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints CASCADE`);
      const [ep] = await db
        .insert(x402Endpoints)
        .values({ resourceKey: "https://shape-next.example/api", resourceUrl: "https://shape-next.example/api", status: "active" })
        .returning();
      const mk = (body: string, daysAgo: number) => ({
        endpointId: ep!.id,
        status: "settled" as const,
        spentUnits: "1000",
        httpStatusPaid: 200,
        l2Schema: "no_declaration",
        attemptedAt: new Date(Date.now() - daysAgo * 86_400_000),
        rawResponseMeta: { phase: "paid", bodyHead: body, bodyBytes: Buffer.byteLength(body), contentType: "application/json" },
        challenge402: {},
      });
      await db.insert(x402L1Purchases).values(mk('{"k":', 12));
      await db.insert(x402L1Purchases).values(mk('{"k":1}', 10));
      const [last] = await db.insert(x402L1Purchases).values(mk('{"k":2}', 2)).returning();
      await runAnswerCheckCron({ batchSize: 10, budgetMs: 30_000 });
      const raw = await db.execute(sql`SELECT raw_response_meta->'answerCheck' AS ac FROM x402_l1_purchases WHERE id = ${last!.id}::uuid`);
      const ac = ((Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows)[0] as { ac: Record<string, unknown> }).ac;
      assert.equal(ac.shapeBaseline, "same");
    });
  });
}