import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("find u1 pg (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  type Ep = { id: string; url: string; resourceKey: string };

  async function setup() {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { canonicalUrl, resourceId, endpointHash } = await import("@/lib/ids/canonical");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases RESTART IDENTITY`);

    async function insertEp(url: string, description: string): Promise<Ep> {
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
      return { id: rows[0]!.id, url, resourceKey };
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

    return { db, insertEp, buy };
  }

  function rowsOf(raw: unknown): Record<string, unknown>[] {
    return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  }

  test("handleFind with readFindAlternatives does not rank low rate or untested above good listings", async () => {
    const { db, insertEp, buy } = await setup();
    const { readFindAlternatives } = await import("@/lib/find/reads");
    const { handleFind } = await import("@/lib/find/find-handler");
    const { searchLikePattern } = await import("@/lib/observatory/reader");
    const { FIND_POOL_SIZE, FIND_WINDOW_DAYS, FIND_MIN_DELIVERED_RATE } = await import("@/lib/find/rank");

    const pasted = "https://paste.example/v1/search";
    const pasteEp = await insertEp(pasted, "Search");
    const good = await insertEp("https://good.example/v1/search", "Search the web");
    const low = await insertEp("https://low.example/v1/search", "Search low");
    await insertEp("https://none.example/v1/search", "No purchases");

    await buy(pasteEp.id, 5, 0, "p");
    await buy(good.id, 20, 0, "g");
    await buy(low.id, 3, 7, "l");

    const opts = {
      limit: FIND_POOL_SIZE,
      minDeliveredPct: Math.round(FIND_MIN_DELIVERED_RATE * 100),
      windowDays: FIND_WINDOW_DAYS,
    };
    const like = searchLikePattern("search")!;
    const deps = {
      findAlternatives: (l: string, limit: number) => readFindAlternatives(db, l, { ...opts, limit }),
    };
    const res = await handleFind(new Request(`https://vet402.com/api/v1/find?url=${encodeURIComponent(pasted)}`), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.alternatives.length >= 1);
    assert.equal(body.alternatives[0].url, good.url);
    const urls = body.alternatives.map((a: { url: string }) => a.url);
    assert.ok(!urls.includes(low.url));
    assert.ok(!urls.includes(pasted));
    assert.ok(!urls.includes("https://none.example/v1/search"));

    const fromReader = await readFindAlternatives(db, like, opts);
    const ids = fromReader.listings.map((x) => x.url);
    assert.ok(ids.includes(good.url));
    assert.ok(!ids.includes("https://none.example/v1/search"));
  });

  test("readFindAlternatives returns 10/10 seller when 30 low-rate sellers would crowd the old pool", async () => {
    const { db, insertEp, buy } = await setup();
    const { readFindAlternatives } = await import("@/lib/find/reads");
    const { handleFind } = await import("@/lib/find/find-handler");
    const { searchLikePattern } = await import("@/lib/observatory/reader");
    const { FIND_POOL_SIZE, FIND_WINDOW_DAYS, FIND_MIN_DELIVERED_RATE } = await import("@/lib/find/rank");

    const good = await insertEp("https://perfect.example/v1/crowdterm", "crowdterm perfect");
    await buy(good.id, 10, 0, "g");

    for (let i = 0; i < 30; i++) {
      const ep = await insertEp(`https://low${i}.example/v1/crowdterm`, `crowdterm low ${i}`);
      await buy(ep.id, 30, 20, `l${i}`);
    }

    const fail79 = await insertEp("https://edge79.example/v1/crowdterm", "crowdterm edge79");
    await buy(fail79.id, 79, 21, "e");

    const opts = {
      limit: FIND_POOL_SIZE,
      minDeliveredPct: Math.round(FIND_MIN_DELIVERED_RATE * 100),
      windowDays: FIND_WINDOW_DAYS,
    };
    const like = searchLikePattern("crowdterm")!;
    const found = await readFindAlternatives(db, like, opts);
    const urls = found.listings.map((x) => x.url);
    assert.ok(urls.includes(good.url), "10/10 seller must be in SQL pool");
    assert.ok(!urls.includes(fail79.url), "79% seller must be filtered in SQL");
    assert.equal(found.listings.filter((x) => x.url === good.url).length, 1);

    const res = await handleFind(new Request("https://vet402.com/api/v1/find?q=crowdterm"), {
      findAlternatives: (l, limit) => readFindAlternatives(db, l, { ...opts, limit }),
    });
    const body = await res.json();
    const altUrls = body.alternatives.map((a: { url: string }) => a.url);
    assert.ok(altUrls.includes(good.url));
    assert.ok(!altUrls.includes(fail79.url));
  });

  test("findAlternativesSql accepts string-typed params like neon-http", async () => {
    const { db, insertEp, buy } = await setup();
    const { readFindAlternatives, findAlternativesSql } = await import("@/lib/find/reads");
    const { searchLikePattern } = await import("@/lib/observatory/reader");
    const { FIND_POOL_SIZE, FIND_WINDOW_DAYS, FIND_MIN_DELIVERED_RATE } = await import("@/lib/find/rank");

    const ep = await insertEp("https://unsafe.example/v1/unsafeterm", "unsafeterm listing");
    await buy(ep.id, 10, 0, "u");

    const opts = {
      limit: FIND_POOL_SIZE,
      minDeliveredPct: Math.round(FIND_MIN_DELIVERED_RATE * 100),
      windowDays: FIND_WINDOW_DAYS,
    };
    const like = searchLikePattern("unsafeterm")!;
    const viaDrizzle = await readFindAlternatives(db, like, opts);

    const dialect = new PgDialect();
    const query = findAlternativesSql(like, opts);
    const { sql: text, params } = dialect.sqlToQuery(query);
    const client = postgres(TEST_DB!, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      const strParams = params.map((p) => String(p));
      const unsafeRows = await client.unsafe(text, strParams);
      assert.ok(Array.isArray(unsafeRows));
      const normalized = rowsOf(unsafeRows).map((r) => String(r.id));
      const drizzleIds = viaDrizzle.listings.map((r) => r.observatoryId).sort();
      assert.deepEqual(normalized.sort(), drizzleIds);
    } finally {
      await client.end({ timeout: 1 });
    }
  });
}