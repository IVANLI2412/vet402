// ============================================================
// U1（2026-11-15）: トップの貼り付け → 判定と代わりの候補が返るまでの時間を、本物の Postgres と route の関数まで通して 20 回測る。
// 頁は /api/v1/check と /api/v1/find を並行に呼ぶので、1 回 = 2 つの GET を同時に投げて両方が返るまで。
// 判定のキャッシュ（decisionCache・5 分）は毎回消し、冷えた読みで測る。CDN・Next の外側・回線の時間は入らない（手元の値）。
// 件数: x402_endpoints 20,000 行（掲載中 16,000）、x402_l1_purchases 約 6,000 行。目標は p50 3 秒以内。
//
// Run: TEST_DATABASE_URL=postgres://postgres@localhost:55454/vet402test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/paste-latency-u1.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RUNS = 20;
const P50_LIMIT_MS = 3_000;

if (!TEST_DB) {
  test("paste latency (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.PROXY_HEADER_SOURCE = "generic";

  test("U1: 貼り付け → check と find の両方が返るまで、20 回の p50 が 3 秒以内", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { resolve } = await import("@/lib/resolve/lookup");
    const { decide } = await import("@/lib/decision/decide");
    const { decisionCache } = await import("@/lib/decision/cache");
    const { readPurchasedHosts, readSellerBoard, readSellerDetail, readSellerOtherChains } = await import("@/lib/sellers/reader");
    const { readFindSellers, readHostExtras, readL1Purchases } = await import("@/lib/mcp/reads");
    const { setMcpDepsForTest } = await import("@/lib/mcp/deps");
    const { GET: checkGET } = await import("@/app/api/v1/check/route");
    const { GET: findGET } = await import("@/app/api/v1/find/route");
    const { NextRequest } = await import("next/server");
    const db = getDb()!;

    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, settlements, client_usage_daily, ip_rate_limits, runtime_flags, x402_resource_aliases, decision_lookups, decision_lookup_callers`,
    );
    decisionCache.clear();

    // canonical_url と resource_id は src/lib/ids/canonical.ts と同じ規則で SQL の外から作る代わりに、resolve が引ける形で入れる。
    const { canonicalUrl, resourceId, endpointHash } = await import("@/lib/ids/canonical");
    const N = 20_000;
    const BATCH = 2_000;
    for (let start = 1; start <= N; start += BATCH) {
      const values = [];
      for (let n = start; n < start + BATCH && n <= N; n++) {
        const url = `https://host${n % 3000}.example/api/v1/${n % 40 === 0 ? "weather/forecast" : n % 7 === 0 ? "search" : "data"}/r${n}`;
        const c = canonicalUrl(url)!;
        const u = new URL(c.url);
        values.push(sql`(${`${u.host}${u.pathname}`.toLowerCase()}, ${url}, 'cdp_bazaar', 'GET', 'eip155:8453', ${"0x" + n.toString(16).padStart(40, "0")},
          ${String(1000 * (1 + (n % 50)))}, ${n % 40 === 0 ? "Weather forecast for any city." : "Paid API for agents with x402 payments."},
          ${n <= N * 0.8 ? "active" : "delisted"}, ${c.url}, ${resourceId("GET", c.url)}, ${endpointHash(c.url)}, now())`);
      }
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, description, status, canonical_url, resource_id, endpoint_hash, last_seen_at)
        VALUES ${sql.join(values, sql`, `)}`);
    }
    await db.execute(sql`
      WITH ids AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM x402_endpoints WHERE status = 'active')
      INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, network, http_status_paid, payload_non_empty, tx_hash, spent_units, amount_units)
      SELECT ids.id, now() - ((g % 29) || ' days')::interval,
             CASE WHEN g % 5 = 0 THEN 'settle_failed' ELSE 'settled' END, 'eip155:8453',
             CASE WHEN g % 5 = 0 THEN 500 ELSE 200 END, CASE WHEN g % 5 = 0 THEN NULL ELSE true END,
             '0x' || lpad(to_hex(g), 64, '0'), '1000', '1000'
      FROM generate_series(1, 6000) g JOIN ids ON ids.rn = 1 + (g * 7) % 16000`);
    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, dialect, http_status)
      SELECT id, now() - interval '1 day', 'GET', 'pass', 'v2', 402 FROM x402_endpoints WHERE status = 'active' AND random() < 0.5`);
    await db.execute(sql`ANALYZE`);

    setMcpDepsForTest({
      resolve,
      decide,
      l1Purchases: (id) => readL1Purchases(db, id),
      sellerPage: {
        board: () => readSellerBoard(db),
        detail: (h) => readSellerDetail(db, h),
        purchasedHosts: () => readPurchasedHosts(db),
        otherChains: (h) => readSellerOtherChains(db, h),
      },
      hostExtras: (h) => readHostExtras(db, h),
      findSellers: (like, limit) => readFindSellers(db, like, limit),
    });

    // 20 の URL: 届いた行のある weather/forecast の掲載から取る（判定ありの道）
    const raw = await db.execute(sql`
      SELECT e.resource_url FROM x402_endpoints e
      WHERE e.status = 'active' AND e.resource_url LIKE '%weather/forecast%'
        AND EXISTS (SELECT 1 FROM x402_l1_purchases p WHERE p.endpoint_id = e.id)
      ORDER BY e.id LIMIT ${RUNS}`);
    const urls = ((Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as { resource_url: string }[]).map((r) => r.resource_url);
    assert.equal(urls.length, RUNS);

    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      decisionCache.clear();
      const q = encodeURIComponent(urls[i]);
      const headers = { "x-forwarded-for": `10.0.0.${i + 1}` };
      const t0 = performance.now();
      const [c, f] = await Promise.all([
        checkGET(new NextRequest(`http://localhost:3000/api/v1/check?url=${q}`, { headers })),
        findGET(new NextRequest(`http://localhost:3000/api/v1/find?url=${q}`, { headers })),
      ]);
      const [cb, fb] = await Promise.all([c.json(), f.json()]);
      times.push(performance.now() - t0);
      assert.equal(c.status, 200, JSON.stringify(cb));
      assert.equal(f.status, 200, JSON.stringify(fb));
      assert.equal(cb.not_in_catalog, false);
      assert.ok(["ALLOW", "WARN", "BLOCK"].includes(cb.recommendation));
    }
    setMcpDepsForTest(null);
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = (sorted[RUNS / 2 - 1] + sorted[RUNS / 2]) / 2;
    const p95 = sorted[Math.ceil(RUNS * 0.95) - 1];
    console.log(`U1 paste latency ms: p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} min=${sorted[0].toFixed(1)} max=${sorted[RUNS - 1].toFixed(1)} runs=${RUNS}`);
    console.log(`U1 paste latency raw ms: ${times.map((t) => t.toFixed(1)).join(",")}`);
    assert.ok(p50 <= P50_LIMIT_MS, `p50 ${p50.toFixed(1)} ms > ${P50_LIMIT_MS}`);
  });
}
