// ============================================================
// Seller ERC-8004 binding SQL against the real schema.
// Run: TEST_DATABASE_URL=... npm run test:db -- tests/seller-erc8004-binding.pg.test.ts
// ============================================================
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("seller erc8004 binding SQL (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const OWN_HOSTS = ["erc8004-seller-binding.example", "other-host.example", "erc8004-wallet-binding.example"] as const;

  async function removeOwnRows() {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    const keys = sql.join(OWN_HOSTS.map((h) => sql`${`${h}/%`}::text`), sql`, `);
    await db.execute(sql`DELETE FROM x402_l1_purchases WHERE endpoint_id IN (SELECT id FROM x402_endpoints WHERE resource_key LIKE ANY (ARRAY[${keys}]))`);
    await db.execute(sql`DELETE FROM x402_endpoints WHERE resource_key LIKE ANY (ARRAY[${keys}])`);
    await db.execute(sql`TRUNCATE owner_agents, agents`);
  }

  before(async () => {
    await removeOwnRows();
  });

  test("seller erc8004 binding: host payTo matches Base agent by exact address", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { readSellerErc8004Binding } = await import("@/lib/sellers/erc8004-binding");
    const db = getDb()!;

    const owner = "0xabcdef0000000000000000000000000000000001";
    const host = OWN_HOSTS[0];

    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `${host}/paid`,
        resourceUrl: `https://${host}/paid`,
        network: "eip155:8453",
        method: "GET",
        status: "active",
      })
      .returning();

    const [otherEp] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `${OWN_HOSTS[1]}/x`,
        resourceUrl: `https://${OWN_HOSTS[1]}/x`,
        network: "eip155:8453",
        method: "GET",
        status: "active",
      })
      .returning();

    await db.execute(sql`INSERT INTO owner_agents (owner, agent_id) VALUES (${owner}, 42)`);
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, pay_to) VALUES
        (${ep!.id}::uuid, 'settled', ${owner}),
        (${ep!.id}::uuid, 'settle_failed', ${owner}),
        (${otherEp!.id}::uuid, 'settled', ${owner})
    `);

    const binding = await readSellerErc8004Binding(host);
    assert.equal(binding.status, "ok");
    if (binding.status !== "ok") return;
    assert.equal(binding.totalAgents, 1);
    assert.equal(binding.agents.length, 1);
    assert.equal(binding.agents[0]!.agentId, "42");
    assert.equal(binding.agents[0]!.payTo, owner);
    assert.equal(binding.agents[0]!.matchedBy, "owner_only");
    // otherEp is another host paying the same address: its row stays out of this seller's counts.
    assert.equal(binding.agents[0]!.purchases, 2);
    assert.equal(binding.agents[0]!.settled, 1);
  });

  test("seller erc8004 binding: wallet_confirmed when agentWallet equals payTo", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { readSellerErc8004Binding } = await import("@/lib/sellers/erc8004-binding");
    const db = getDb()!;

    const wallet = "0xb0b0000000000000000000000000000000000001";
    const host = OWN_HOSTS[2];

    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `${host}/v1`,
        resourceUrl: `https://${host}/v1`,
        network: "eip155:8453",
        method: "GET",
        status: "active",
      })
      .returning();

    await db.execute(sql`INSERT INTO owner_agents (owner, agent_id) VALUES (${wallet}, 11)`);
    await db.execute(sql`INSERT INTO agents (agent_id, chain_id, wallet) VALUES (11, 8453, ${wallet})`);
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, pay_to) VALUES (${ep!.id}::uuid, 'settled', ${wallet})
    `);

    const binding = await readSellerErc8004Binding(host);
    assert.equal(binding.status, "ok");
    if (binding.status !== "ok") return;
    assert.equal(binding.agents[0]!.matchedBy, "wallet_confirmed");
  });
}