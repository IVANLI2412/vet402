import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_REVERT_STREAK_END,
  advanceStateFold,
  foldStateMulticallBatch,
  indexErc8004StateChain,
  ERC8004_STATE_TARGETS,
  type StateFoldState,
} from "@/lib/indexer/erc8004-state-indexer";
import { erc8004StateCheckpointScope } from "@/lib/db/erc8004-chain-index";
import type { Address, Hex } from "viem";

const OWNER = `0x${"aa".repeat(20)}` as Address;
const WALLET = `0x${"bb".repeat(20)}` as Address;

function padAddress(addr: Address): Hex {
  return `0x000000000000000000000000${addr.slice(2)}` as Hex;
}

test("foldStateMulticallBatch skips owner revert and keeps wallet on success", () => {
  const ids = [1n, 2n, 3n] as const;
  const ownerResults = [
    { success: true, returnData: padAddress(OWNER) },
    { success: false, returnData: "0x" as Hex },
    { success: true, returnData: padAddress(OWNER) },
  ];
  const walletResults = [
    { success: true, returnData: padAddress(WALLET) },
    { success: true, returnData: padAddress(WALLET) },
    { success: true, returnData: "0x" as Hex },
  ];
  const rows = foldStateMulticallBatch(ids, ownerResults, walletResults, "full");
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.ownerMissing, false);
  assert.equal(rows[0]!.wallet?.toLowerCase(), WALLET.toLowerCase());
  assert.equal(rows[1]!.ownerMissing, true);
  assert.equal(rows[2]!.wallet, null);
});

test(`advanceStateFold ends lap after ${STATE_REVERT_STREAK_END} consecutive owner misses`, () => {
  const fold: StateFoldState = { consecutiveOwnerReverts: STATE_REVERT_STREAK_END - 1, lastSuccessfulId: 40n };
  const rows = [{ agentId: 41n, ownerMissing: true, wallet: null }];
  const { lapEnded, fold: next } = advanceStateFold(fold, rows, "full");
  assert.equal(lapEnded, true);
  assert.equal(next.consecutiveOwnerReverts, STATE_REVERT_STREAK_END);
  assert.equal(next.lastSuccessfulId, 40n);
});

test("indexErc8004StateChain saves cursor and resumes", async () => {
  const eth = ERC8004_STATE_TARGETS.find((t) => t.caip2 === "eip155:1")!;
  const scope = erc8004StateCheckpointScope(eth.caip2);
  let checkpoint = 0n;
  let lapCursor: string | null = null;
  let supply: bigint | undefined;
  const calls: bigint[][] = [];

  const aggregate3 = async (_client: unknown, ids: bigint[]) => {
    calls.push(ids);
    const ownerResults = ids.map(() => ({ success: true, returnData: padAddress(OWNER) }));
    const walletResults = ids.map(() => ({ success: true, returnData: padAddress(WALLET) }));
    return {
      rows: foldStateMulticallBatch(ids, ownerResults, walletResults, "full"),
      ownerResults,
      walletResults,
    };
  };

  const applyChain = async () => {};

  const deps = {
    now: () => Date.now(),
    env: {},
      makeClient: () => ({}) as never,
    getCheckpoint: async () => checkpoint,
    getCheckpointMeta: async () =>
      checkpoint || lapCursor
        ? { lastBlock: checkpoint, lastCursor: lapCursor, supplyEstimate: supply ?? null }
        : null,
    setCheckpoint: async (_s: string, lastBlock: bigint, est?: bigint, lastCursor?: string | null) => {
      checkpoint = lastBlock;
      if (est !== undefined) supply = est;
      if (lastCursor !== undefined) lapCursor = lastCursor;
    },
    aggregate3,
    applyChain,
    applyWallets: async () => {},
  };

  const r1 = await indexErc8004StateChain(eth, { maxIds: 150, timeBudgetMs: 60_000, deps });
  assert.equal(r1.status, "ok");
  if (r1.status !== "ok") return;
  assert.equal(r1.idsRead, 150);
  assert.equal(checkpoint, 150n);

  const r2 = await indexErc8004StateChain(eth, { maxIds: 100, timeBudgetMs: 60_000, deps });
  assert.equal(r2.status, "ok");
  if (r2.status !== "ok") return;
  assert.equal(calls[1]![0], 151n);
  assert.equal(checkpoint, 250n);
});

test("indexErc8004StateChain stops on time budget without calling RPC after deadline", async () => {
  const eth = ERC8004_STATE_TARGETS.find((t) => t.caip2 === "eip155:1")!;
  let t = 0;
  let rpc = 0;
  const deps = {
    now: () => t,
    env: {},
      makeClient: () => ({}) as never,
    getCheckpoint: async () => 0n,
    getCheckpointMeta: async () => null,
    setCheckpoint: async () => {},
    aggregate3: async () => {
      rpc += 1;
      t += 5_000;
      const ids = [BigInt(rpc)];
      const ownerResults = [{ success: true, returnData: padAddress(OWNER) }];
      const walletResults = [{ success: true, returnData: padAddress(WALLET) }];
      return {
        rows: foldStateMulticallBatch(ids, ownerResults, walletResults, "full"),
        ownerResults,
        walletResults,
      };
    },
    applyChain: async () => {},
    applyWallets: async () => {},
  };

  const r = await indexErc8004StateChain(eth, { maxIds: 10_000, timeBudgetMs: 12_000, startedAt: 0, deps });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.ok(r.partial);
  assert.equal(r.stoppedBy, "time_budget");
  assert.ok(rpc < 10_000);
});