// ============================================================
// delivery.csv の DB 統合試験。
// Run: TEST_DATABASE_URL=postgres://postgres@localhost:55453/vet402test \
//   npx tsx --test --test-concurrency=1 --test-force-exit tests/delivery-export.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { DELIVERY_CSV_COLUMNS } from "@/lib/observatory/delivery-export";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { deliveryOutcomeOf } from "@/lib/observatory/delivery-values";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("delivery export pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("delivery.csv: 見出し・3 値・observed_at・buyer・payer・窓", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "delivery-csv.example/api",
        resourceUrl: "https://delivery-csv.example/api",
        network: "eip155:8453",
        method: "GET",
        payTo: `0x${"a".repeat(40)}`,
      })
      .returning();

    const now = new Date();
    // 秒に切らない時刻（.987）。observed_at が attempted_at の元の精度から作られることを固定する。
    const inWindow = new Date(Math.floor((now.getTime() - 2 * 24 * 60 * 60 * 1000) / 1000) * 1000 + 987);
    const outWindow = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    const payer = `0x${"b".repeat(40)}`;
    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;

    type Seed = {
      status: string;
      http: number | null;
      body?: boolean | null;
      at: Date;
      latency?: number;
    };
    const seeds: Seed[] = [
      { status: "settled", http: 200, body: true, at: inWindow, latency: 1500 },
      { status: "settled", http: 200, body: null, at: inWindow, latency: 500 },
      { status: "settled", http: 202, at: inWindow, latency: 100 },
      { status: "settled", http: 200, body: false, at: inWindow },
      { status: "settled", http: 500, at: inWindow, latency: 2000 },
      { status: "settled", http: 404, at: inWindow },
      { status: "settled", http: 402, at: inWindow },
      { status: "settled", http: 307, at: inWindow },
      { status: "settled", http: null, at: inWindow },
      { status: "settle_failed", http: 400, at: inWindow },
      { status: "settle_claimed", http: 200, at: inWindow },
      { status: "settled", http: 200, body: true, at: outWindow },
    ];
    for (const s of seeds) {
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: s.status,
        httpStatusPaid: s.http,
        txHash: s.status === "settled" ? tx() : null,
        attemptedAt: s.at,
        network: "eip155:8453",
        spentUnits: "1000",
        amountUnits: "1000",
        settlementVerified: s.status === "settled",
        ...(s.body !== undefined ? { payloadNonEmpty: s.body } : {}),
        ...(s.latency !== undefined ? { latencyMs: s.latency } : {}),
        payer,
      });
    }

    // マイクロ秒を足す（.987400）。observed_at は元の精度に足してミリ秒に切り上げる（.987400 + latency → .988）。
    await db.execute(sql`UPDATE x402_l1_purchases SET attempted_at = attempted_at + interval '400 microseconds'`);

    const { GET } = await import("@/app/api/v1/observatory/delivery.csv/route");
    const res = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/delivery.csv?days=90", {
        headers: { "x-forwarded-for": "203.0.113.55" },
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const [header, ...dataLines] = text.trim().split("\n");
    assert.equal(header, DELIVERY_CSV_COLUMNS.join(","));
    const settledInWindow = seeds.filter((s) => s.status === "settled" && s.at.getTime() >= inWindow.getTime());
    assert.equal(dataLines.length, settledInWindow.length, "settled のみ・窓内のみ");

    const col = (name: string, line: string) => {
      const i = DELIVERY_CSV_COLUMNS.indexOf(name as (typeof DELIVERY_CSV_COLUMNS)[number]);
      return line.split(",")[i]!;
    };

    for (const line of dataLines) {
      assert.equal(col("buyer", line), "vet402");
      assert.equal(col("payer", line), payer);
      const http = col("http_status_paid", line);
      const delivery = col("delivery", line);
      const reason = col("delivery_reason", line);
      const payload = col("payload_non_empty", line);
      const outcome = deliveryOutcomeOf({
        status: "settled",
        httpStatusPaid: http === "" ? null : Number(http),
        payloadNonEmpty: payload === "" ? null : payload === "true",
      });
      assert.equal(delivery, outcome?.delivery);
      assert.equal(reason, outcome?.reason ?? "");
      const attempted = col("attempted_at", line);
      const latency = col("latency_ms", line);
      const observed = col("observed_at", line);
      if (latency !== "") {
        // 上限: 秒に切った attempted_at ではなく、記録の時刻（.987）に latency_ms を足した値。
        const expected = new Date(inWindow.getTime() + Number(latency) + 1).toISOString();
        assert.equal(observed, expected);
        assert.ok(Date.parse(observed) > Date.parse(attempted) + Number(latency), "秒に切った値より後");
      } else {
        assert.equal(observed, "");
      }
    }
  });

  test("窓の外の settled を残したまま: CSV の和は窓内の settled・delivered は deliveredPredicate", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { deliveredPredicate } = await import("@/lib/observatory/delivery");
    const db = getDb()!;
    const raw = await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'settled' AND attempted_at >= now() - make_interval(days => 90))::int AS settled_in,
             count(*) FILTER (WHERE ${sql.raw(deliveredPredicate())} AND attempted_at >= now() - make_interval(days => 90))::int AS delivered_in,
             count(*) FILTER (WHERE status = 'settled' AND attempted_at < now() - make_interval(days => 90))::int AS settled_out
      FROM x402_l1_purchases`);
    const r = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, number>[])[0]!;
    assert.ok(Number(r.settled_out) >= 1, "窓の外の settled が残っている");
    const { GET } = await import("@/app/api/v1/observatory/delivery.csv/route");
    const res = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/delivery.csv?days=90", {
        headers: { "x-forwarded-for": "203.0.113.57" },
      }),
    );
    const lines = (await res.text()).trim().split("\n").slice(1);
    const iDel = DELIVERY_CSV_COLUMNS.indexOf("delivery");
    const counts = { delivered: 0, no_body_observed: 0, not_established: 0 } as Record<string, number>;
    for (const line of lines) counts[line.split(",")[iDel]!]! += 1;
    assert.equal(counts.delivered + counts.no_body_observed + counts.not_established, Number(r.settled_in));
    assert.equal(counts.delivered, Number(r.delivered_in));
    // 種の内訳: delivered 2（本文あり・本文の記録なし）、no_body_observed 2（空の 200・500）、not_established 5（202・404・402・307・HTTP なし）。
    assert.deepEqual(counts, { delivered: 2, no_body_observed: 2, not_established: 5 });
  });

  test("3 値の集計が公開の delivered と一致", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    await getDb()!.execute(sql`
      DELETE FROM x402_l1_purchases WHERE attempted_at < now() - make_interval(days => 90)
    `);
    const { getObservatoryStats } = await import("@/lib/observatory/reader");
    const { GET } = await import("@/app/api/v1/observatory/delivery.csv/route");
    const stats = await getObservatoryStats();
    const res = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/delivery.csv?days=90", {
        headers: { "x-forwarded-for": "203.0.113.56" },
      }),
    );
    const lines = (await res.text()).trim().split("\n").slice(1);
    let delivered = 0;
    let total = 0;
    const iDel = DELIVERY_CSV_COLUMNS.indexOf("delivery");
    for (const line of lines) {
      total++;
      if (line.split(",")[iDel] === "delivered") delivered++;
    }
    assert.equal(delivered, stats.l1.delivered);
    assert.equal(total, stats.l1.settled);
  });

  test("既定の export.csv と settled の purchase_id 集合が同じ", async () => {
    const ledger = await import("@/app/api/v1/observatory/export.csv/route");
    const delivery = await import("@/app/api/v1/observatory/delivery.csv/route");
    const rE = await ledger.GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=90", {
        headers: { "x-forwarded-for": "203.0.113.57" },
      }),
    );
    const rD = await delivery.GET(
      new NextRequest("https://vet402.com/api/v1/observatory/delivery.csv?days=90", {
        headers: { "x-forwarded-for": "203.0.113.58" },
      }),
    );
    assert.equal(rE.status, 200);
    assert.equal(rD.status, 200);
    const eLines = (await rE.text()).trim().split("\n");
    const dLines = (await rD.text()).trim().split("\n");
    assert.equal(eLines[0], EXPORT_CSV_COLUMNS.join(","));
    assert.equal(dLines[0], DELIVERY_CSV_COLUMNS.join(","));

    const statusIdx = EXPORT_CSV_COLUMNS.indexOf("status");
    const purchaseIdxE = EXPORT_CSV_COLUMNS.indexOf("purchase_id");
    const purchaseIdxD = DELIVERY_CSV_COLUMNS.indexOf("purchase_id");
    const settledIds = new Set(
      eLines.slice(1).filter((l) => l.split(",")[statusIdx] === "settled").map((l) => l.split(",")[purchaseIdxE]),
    );
    const deliveryIds = new Set(dLines.slice(1).map((l) => l.split(",")[purchaseIdxD]));
    assert.deepEqual(deliveryIds, settledIds);
  });
}