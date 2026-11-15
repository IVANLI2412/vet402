// buildJudgmentShard filters active 64-hex resource_id rows by shard prefix (2026-11-15).
// Run: TEST_DATABASE_URL=postgres://postgres@localhost:55452/vet402test env -u DATABASE_URL \
//   npx tsx --test --test-concurrency=1 --test-force-exit tests/judgments-build.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

function rid(prefix: string): string {
  return prefix.padEnd(64, "0");
}

function ridWithPrefix2(hex2: string, tail: string): string {
  const pad = 64 - hex2.length - tail.length;
  assert.ok(pad >= 0);
  return hex2 + tail + "0".repeat(pad);
}

if (!TEST_DB) {
  test("judgments build (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("buildJudgmentShard keeps active 64-hex ids in range, sorted, unique", async () => {
    const { buildJudgmentShard } = await import("@/lib/judgments/build");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const delistedOnly = ridWithPrefix2("00", "d");

    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_delisting_events, customer_lists, x402_resource_aliases`,
    );

    const mk = async (opts: {
      resourceId: string | null;
      status: string;
      url: string;
    }) => {
      await db.insert(schema.x402Endpoints).values({
        resourceKey: `GET ${opts.url}`,
        resourceUrl: opts.url,
        method: "GET",
        network: "eip155:8453",
        payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        priceAmount: "1000",
        status: opts.status,
        canonicalUrl: opts.url,
        resourceId: opts.resourceId,
      });
    };

    await mk({ resourceId: rid("00"), status: "active", url: "https://shard00.example/x" });
    await mk({ resourceId: rid("0f"), status: "active", url: "https://shard0f.example/x" });
    await mk({ resourceId: rid("10"), status: "active", url: "https://shard10.example/x" });
    await mk({ resourceId: rid("ff"), status: "active", url: "https://shardff.example/x" });
    await mk({ resourceId: delistedOnly, status: "delisted", url: "https://delisted-only-00.example/x" });
    await mk({ resourceId: null, status: "active", url: "https://no-rid.example/x" });
    await mk({ resourceId: "not-a-64-hex-resource-id", status: "active", url: "https://bad-rid.example/x" });

    const shard00 = await buildJudgmentShard("00");
    const ids00 = shard00.map((r) => r.resource_id);
    assert.deepEqual(ids00, [rid("00")]);
    assert.ok(!ids00.includes(rid("0f")));
    assert.ok(!ids00.includes(delistedOnly), "delisted-only row with same shard prefix is excluded");

    const shard0f = await buildJudgmentShard("0f");
    assert.deepEqual(shard0f.map((r) => r.resource_id), [rid("0f")]);

    const shardFf = await buildJudgmentShard("ff");
    assert.deepEqual(shardFf.map((r) => r.resource_id), [rid("ff")]);
  });

  test("buildJudgment returns null for alias id; global operator blacklist matches key-less /decision", async () => {
    const { buildJudgment } = await import("@/lib/judgments/build");
    const { invalidateDecisionCache } = await import("@/lib/decision/decide");
    const { GET } = await import("@/app/api/v1/resources/[resourceId]/decision/route");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { NextRequest } = await import("next/server");
    const db = getDb()!;

    const PAY = "0x00000000000000000000000000000000000000cc";
    const payeeId = `eip155:8453:${PAY}`;
    const canonicalId = rid("ab");
    const aliasId = ridWithPrefix2("ab", "f");

    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_delisting_events, customer_lists, x402_resource_aliases, x402_l0_probes, x402_l1_purchases, ip_rate_limits`,
    );

    await db.insert(schema.x402Endpoints).values({
      resourceKey: "GET https://blacklist-judgment.example/x",
      resourceUrl: "https://blacklist-judgment.example/x",
      method: "GET",
      network: "eip155:8453",
      payTo: PAY,
      payeeId,
      priceAmount: "1000",
      status: "active",
      canonicalUrl: "https://blacklist-judgment.example/x",
      resourceId: canonicalId,
    });

    await db.insert(schema.x402ResourceAliases).values({
      aliasId,
      resourceId: canonicalId,
    });

    await db.insert(schema.customerLists).values({
      apiKeyId: null,
      wallet: PAY,
      listType: "blacklist",
    });

    invalidateDecisionCache();

    const built = await buildJudgment(canonicalId, "2026-11-15");
    assert.ok(built);
    assert.equal(built.recommendation, "BLOCK");
    assert.ok((built.reason_codes as string[]).includes("operator_blacklist"));

    const aliasBuilt = await buildJudgment(aliasId, "2026-11-15");
    assert.equal(aliasBuilt, null, "alias id must not produce a judgment doc");

    const req = new NextRequest(
      `http://localhost/api/v1/resources/${canonicalId}/decision?role=payer`,
      { headers: { "x-forwarded-for": "203.0.113.77" } },
    );
    const res = await GET(req, { params: Promise.resolve({ resourceId: canonicalId }) });
    assert.equal(res.status, 200);
    const live = (await res.json()) as { recommendation: string; reason_codes: string[] };
    assert.equal(built.recommendation, live.recommendation);
    assert.deepEqual(
      (built.reason_codes as string[]).filter((c) => c === "operator_blacklist"),
      live.reason_codes.filter((c) => c === "operator_blacklist"),
    );
  });
}