import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("readHostCalledVsDelivered (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("readHostCalledVsDelivered skips rows without quality_observed_at", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { readHostCalledVsDelivered } = await import("@/lib/sellers/called-vs-delivered");
    const db = getDb()!;
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
    const host = "counted-host.example";
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, status, quality_calls_30d, quality_observed_at)
      VALUES (${host + "/a"}, ${"https://" + host + "/a"}, 'cdp_bazaar', 'GET', 'eip155:8453', '0x1', 'active', 10, now()),
             (${host + "/b"}, ${"https://" + host + "/b"}, 'cdp_bazaar', 'GET', 'eip155:8453', '0x2', 'active', 99, NULL)
      ON CONFLICT DO NOTHING`);
    const read = await readHostCalledVsDelivered(db, host);
    assert.ok(read, "columns exist, so the read returns figures");
    const data = read;
    assert.equal(data.bazaar.calls30d, 10);
    assert.equal(data.bazaar.listingsWithFigures, 1);
  });

  test("readHostCalledVsDelivered aggregates payers, settled window, delivered and held", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { readHostCalledVsDelivered } = await import("@/lib/sellers/called-vs-delivered");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb()!;
    await db.execute(sql`ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz`);
    const host = "cvd-wave2.example";
    const payTo = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const urlA = `https://${host}/a`;
    const urlB = `https://${host}/b`;
    const ridA = resourceId("GET", urlA);
    const ridB = resourceId("GET", urlB);
    const epRows = await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status,
        quality_calls_30d, quality_payers_30d, quality_observed_at, canonical_url, resource_id, endpoint_hash, payee_id)
      VALUES
        (${host + "/a"}, ${urlA}, 'cdp_bazaar', 'GET', 'eip155:8453', ${payTo}, '1000', ${usdc}, 'active', 1, 4, now(), ${urlA}, ${ridA}, ${endpointHash(urlA)}, ${payeeId("eip155:8453", payTo)}),
        (${host + "/b"}, ${urlB}, 'cdp_bazaar', 'GET', 'eip155:8453', ${payTo}, '1000', ${usdc}, 'active', 1, 9, now(), ${urlB}, ${ridB}, ${endpointHash(urlB)}, ${payeeId("eip155:8453", payTo)})
      ON CONFLICT (resource_key, source) DO UPDATE SET
        quality_payers_30d = excluded.quality_payers_30d,
        quality_observed_at = excluded.quality_observed_at,
        status = 'active'
      RETURNING id::text AS id, resource_key`);
    const epList = (Array.isArray(epRows) ? epRows : ((epRows as { rows?: unknown[] }).rows ?? [])) as {
      id: string;
      resource_key: string;
    }[];
    const eps = epList.sort((a, b) => a.resource_key.localeCompare(b.resource_key));
    const epA = eps[0]!.id;
    const epB = eps[1]!.id;
    const payer = "0x00000000000000000000000000000000000000aa";
    await db.execute(sql`
      DELETE FROM x402_l1_purchases WHERE endpoint_id IN (${epA}::uuid, ${epB}::uuid)`);
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash, http_status_paid, payload_non_empty, attempted_at)
      VALUES
        (${epA}::uuid, 'settled', 'eip155:8453', ${usdc}, ${payTo}, '1000', '1000', ${payer}, ${"0x" + "a".repeat(64)}, 200, true, now() - interval '5 days'),
        (${epB}::uuid, 'settled', 'eip155:8453', ${usdc}, ${payTo}, '1000', '1000', ${payer}, ${"0x" + "b".repeat(64)}, 404, true, now() - interval '3 days'),
        (${epA}::uuid, 'settled', 'eip155:8453', ${usdc}, ${payTo}, '1000', '1000', ${payer}, ${"0x" + "c".repeat(64)}, 200, true, now() - interval '40 days')
    `);
    const read = await readHostCalledVsDelivered(db, host);
    assert.ok(read, "columns exist, so the read returns figures");
    const data = read;
    assert.equal(data.bazaar.payersLargestListing, 9);
    assert.equal(data.vet402.settled, 2);
    assert.equal(data.vet402.delivered, 1);
    assert.equal(data.vet402.heldSettled, 1);
    assert.equal(data.vet402.judged, 1);
    assert.equal(data.vet402.deliveredPct, 100);
  });
}