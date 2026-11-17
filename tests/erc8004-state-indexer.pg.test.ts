import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import type { Address, Hex } from "viem";
import { foldStateMulticallBatch, indexErc8004StateChain, ERC8004_STATE_TARGETS } from "@/lib/indexer/erc8004-state-indexer";
import { applyErc8004ChainAgentChanges, erc8004StateCheckpointScope } from "@/lib/db/erc8004-chain-index";
import { erc8004ChainAgents } from "@/lib/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("erc8004 state indexer (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("state indexer writes erc8004_chain_agents and checkpoint", async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE erc8004_chain_agents`);
    await db.execute(sql`DELETE FROM indexer_checkpoints WHERE scope = ${erc8004StateCheckpointScope("eip155:1")}`);
    const owner = `0x${"cd".repeat(20)}` as Address;
    const wallet = `0x${"de".repeat(20)}` as Address;
    const ownerWord = `0x000000000000000000000000${owner.slice(2)}` as Hex;
    const walletWord = `0x000000000000000000000000${wallet.slice(2)}` as Hex;
    const eth = ERC8004_STATE_TARGETS.find((t) => t.caip2 === "eip155:1")!;

    const r = await indexErc8004StateChain(eth, {
      maxIds: 3,
      deps: {
        env: {},
        makeClient: () => ({}) as never,
        getCheckpoint: async () => null,
        getCheckpointMeta: async () => null,
        setCheckpoint: async (scope, last, est, lap) => {
          const { setIndexerCheckpoint } = await import("@/lib/db/owner-index");
          await setIndexerCheckpoint(scope, last, est, lap);
        },
        aggregate3: async (_c, ids) => {
          const ownerResults = ids.map(() => ({ success: true, returnData: ownerWord }));
          const walletResults = ids.map((id) =>
            id === 2n ? { success: true, returnData: walletWord } : { success: true, returnData: "0x" as Hex },
          );
          return {
            rows: foldStateMulticallBatch(ids, ownerResults, walletResults, "full"),
            ownerResults,
            walletResults,
          };
        },
        applyChain: async (chainId, changes) => applyErc8004ChainAgentChanges(chainId, changes),
        applyWallets: async () => {},
      },
    });

    assert.equal(r.status, "ok");
    const listed = await db
      .select({ agentId: erc8004ChainAgents.agentId, owner: erc8004ChainAgents.owner, wallet: erc8004ChainAgents.wallet })
      .from(erc8004ChainAgents)
      .where(eq(erc8004ChainAgents.chainId, 1));
    assert.equal(listed.length, 3);
    assert.equal(listed.find((x) => x.agentId === 2n)?.wallet?.toLowerCase(), wallet.toLowerCase());
    const { getIndexerCheckpoint } = await import("@/lib/db/owner-index");
    assert.equal(await getIndexerCheckpoint(erc8004StateCheckpointScope("eip155:1")), 3n);
  });
}