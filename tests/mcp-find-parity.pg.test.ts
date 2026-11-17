// MCP find_x402_sellers と GET /api/v1/find の順位が同じ fixture で一致する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("mcp find parity (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("find_x402_sellers と handleFind が同じ URL 順を返す", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { canonicalUrl, resourceId, endpointHash } = await import("@/lib/ids/canonical");
    const { readFindAlternatives } = await import("@/lib/find/reads");
    const { readFindUntested } = await import("@/lib/mcp/reads");
    const { handleFind } = await import("@/lib/find/find-handler");
    const { findSellers } = await import("@/lib/mcp/tools");
    const { searchLikePattern } = await import("@/lib/observatory/reader");
    const { FIND_POOL_SIZE, FIND_WINDOW_DAYS, FIND_MIN_DELIVERED_RATE } = await import("@/lib/find/rank");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases RESTART IDENTITY`);

    async function insertEp(url: string, description: string): Promise<string> {
      const c = canonicalUrl(url)!;
      const rid = resourceId("GET", c.url);
      const eh = endpointHash(c.url);
      const u = new URL(c.url);
      const resourceKey = `${u.host}${u.pathname}`.toLowerCase();
      const raw = await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, description, status, canonical_url, resource_id, endpoint_hash, last_seen_at)
        VALUES (${resourceKey}, ${url}, 'cdp_bazaar', 'GET', 'eip155:8453', ${"0x" + resourceKey.length.toString(16).padStart(40, "0")},
          '10000', ${description}, 'active', ${c.url}, ${rid}, ${eh}, now())
        RETURNING id::text AS id`);
      const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];
      return rows[0]!.id;
    }

    async function buy(endpointId: string, delivered: number, failed: number, txPad: string) {
      const n = delivered + failed;
      if (n < 1) return;
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, network, http_status_paid, payload_non_empty, tx_hash, spent_units, amount_units)
        SELECT ${endpointId}::uuid, now() - (i || ' hours')::interval,
          CASE WHEN i <= ${delivered} THEN 'settled' ELSE 'settle_failed' END,
          'eip155:8453',
          CASE WHEN i <= ${delivered} THEN 200 ELSE 500 END,
          CASE WHEN i <= ${delivered} THEN true ELSE NULL END,
          '0x' || lpad((i::text || ${txPad}), 64, 'a'),
          '1000', '1000'
        FROM generate_series(1, ${n}) AS i`);
    }

    const good = await insertEp("https://good.example/v1/search", "Search the web");
    const mid = await insertEp("https://mid.example/v1/search", "Search mid");
    const low = await insertEp("https://low.example/v1/search", "Search low rate");
    await insertEp("https://none.example/v1/search", "No purchases");

    await buy(good, 20, 0, "g");
    await buy(mid, 12, 3, "m");
    await buy(low, 3, 7, "l");

    const opts = {
      limit: FIND_POOL_SIZE,
      minDeliveredPct: Math.round(FIND_MIN_DELIVERED_RATE * 100),
      windowDays: FIND_WINDOW_DAYS,
    };
    const query = "search";
    const like = searchLikePattern(query)!;
    const deps = {
      findAlternatives: (l: string, limit: number) => readFindAlternatives(db, l, { ...opts, limit }),
      findUntested: (l: string) => readFindUntested(db, l),
    };

    const http = await handleFind(new Request(`https://vet402.com/api/v1/find?q=${encodeURIComponent(query)}`), deps);
    assert.equal(http.status, 200);
    const body = await http.json();
    const apiUrls = body.alternatives.map((a: { url: string }) => a.url);

    const mcp = await findSellers(deps as never, { query, limit: 10 });
    assert.notEqual(mcp, "invalid_query");
    if (mcp === "invalid_query") return;
    const mcpUrls = mcp.sellers.map((s: { url: string }) => s.url);

    assert.deepEqual(mcpUrls.slice(0, apiUrls.length), apiUrls);
    assert.ok(!mcpUrls.includes("https://low.example/v1/search"));
  });

  test("query が1文字でも LIKE が作れれば sellers は空配列で invalid にはならない", async () => {
    const { findSellers } = await import("@/lib/mcp/tools");
    const deps = {
      findAlternatives: async () => ({ fetchedAt: new Date().toISOString(), listings: [] }),
      findUntested: async () => [],
    };
    const out = await findSellers(deps as never, { query: "x" });
    assert.notEqual(out, "invalid_query");
    if (out === "invalid_query") return;
    assert.deepEqual(out.sellers, []);
  });
}