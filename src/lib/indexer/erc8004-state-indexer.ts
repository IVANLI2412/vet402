// ============================================================
// ERC-8004 Identity の状態読み索引（2026-11-17）。
//
// eth_getLogs の広い窓は無料 RPC が拒否するので、Multicall3 の aggregate3 で
// ownerOf と getAgentWallet を agentId 順に読む。checkpoint は indexer_checkpoints の
// scope `erc8004_state:<caip2>`・last_block = 読み終えた最後の番号、周回は last_cursor。
// ============================================================
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { base, bsc, mainnet } from "viem/chains";
import { isValidAddress } from "@/lib/chain/client";
import { ERC8004_ADDRESSES } from "@/lib/chain/config";
import { upsertAgentWallets } from "@/lib/db/agent-wallet-index";
import {
  applyErc8004ChainAgentChanges,
  erc8004StateCheckpointScope,
  type Erc8004ChainAgentChanges,
  type Erc8004ExtraChain,
} from "@/lib/db/erc8004-chain-index";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { DeadlineExceededError } from "@/lib/util/deadline";
import { logServerInfoSafe, logServerWarnSafe } from "@/lib/util/log-safe";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const identityStateAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

const aggregate3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export const DEFAULT_STATE_RPC: Record<string, string> = {
  ERC8004_STATE_RPC_ETHEREUM: "https://ethereum-rpc.publicnode.com",
  ERC8004_STATE_RPC_BNB: "https://bsc-rpc.publicnode.com",
  ERC8004_STATE_RPC_BASE: "https://base-rpc.publicnode.com",
};

export const STATE_BATCH_SIZE = 500;
export const STATE_REVERT_STREAK_END = 200;
export const DEFAULT_STATE_TIME_BUDGET_MS = 200_000;
export const DEFAULT_STATE_MAX_IDS = 150_000;

export type Erc8004StateTarget = {
  caip2: Erc8004ExtraChain | "eip155:8453";
  chainId: number;
  rpcEnv: keyof typeof DEFAULT_STATE_RPC;
  /** Base は wallet だけ。Ethereum・BNB は owner と wallet。 */
  mode: "full" | "wallet";
  viemChain: Chain;
};

export const ERC8004_STATE_TARGETS: readonly Erc8004StateTarget[] = [
  {
    caip2: "eip155:1",
    chainId: 1,
    rpcEnv: "ERC8004_STATE_RPC_ETHEREUM",
    mode: "full",
    viemChain: mainnet,
  },
  {
    caip2: "eip155:56",
    chainId: 56,
    rpcEnv: "ERC8004_STATE_RPC_BNB",
    mode: "full",
    viemChain: bsc,
  },
  {
    caip2: "eip155:8453",
    chainId: 8453,
    rpcEnv: "ERC8004_STATE_RPC_BASE",
    mode: "wallet",
    viemChain: base,
  },
];

export type StateBatchRow = {
  agentId: bigint;
  owner?: Address;
  wallet: Address | null;
  /** full: ownerOf が無い。wallet: getAgentWallet が revert。 */
  ownerMissing: boolean;
};

export type StateFoldState = {
  consecutiveOwnerReverts: number;
  lastSuccessfulId: bigint | null;
};

/**
 * Multicall の 1 束（最大 500 件）を行に畳む。ownerOf が失敗した番号は飛ばす。
 * wallet-only では ownerMissing は常に false。
 */
export function foldStateMulticallBatch(
  ids: readonly bigint[],
  ownerResults: readonly { success: boolean; returnData: Hex }[],
  walletResults: readonly { success: boolean; returnData: Hex }[] | null,
  mode: "full" | "wallet",
): StateBatchRow[] {
  const out: StateBatchRow[] = [];
  for (let i = 0; i < ids.length; i++) {
    const agentId = ids[i]!;
    if (mode === "full") {
      const own = ownerResults[i];
      if (!own?.success || own.returnData === "0x") {
        out.push({ agentId, wallet: null, ownerMissing: true });
        continue;
      }
      try {
        const owner = decodeAddressReturn(own.returnData);
        if (!owner || !isValidAddress(owner)) {
          out.push({ agentId, wallet: null, ownerMissing: true });
          continue;
        }
        let wallet: Address | null = null;
        const w = walletResults?.[i];
        if (w?.success && w.returnData !== "0x") {
          const decoded = decodeAddressReturn(w.returnData);
          if (decoded && isValidAddress(decoded) && decoded.toLowerCase() !== zeroAddress) {
            wallet = decoded;
          }
        }
        out.push({ agentId, owner, wallet, ownerMissing: false });
      } catch {
        out.push({ agentId, wallet: null, ownerMissing: true });
      }
    } else {
      const w = walletResults?.[i];
      if (!w?.success) {
        out.push({ agentId, wallet: null, ownerMissing: true });
        continue;
      }
      let wallet: Address | null = null;
      if (w.returnData !== "0x") {
        const decoded = decodeAddressReturn(w.returnData);
        if (decoded && isValidAddress(decoded) && decoded.toLowerCase() !== zeroAddress) {
          wallet = decoded;
        }
      }
      out.push({ agentId, wallet, ownerMissing: false });
    }
  }
  return out;
}

/** 200 件続けて owner が無い（または wallet-only で getAgentWallet だけ）とき周回終了。 */
export function advanceStateFold(
  fold: StateFoldState,
  rows: readonly StateBatchRow[],
  mode: "full" | "wallet",
  revertLimit = STATE_REVERT_STREAK_END,
): { fold: StateFoldState; lapEnded: boolean } {
  let consecutiveOwnerReverts = fold.consecutiveOwnerReverts;
  let lastSuccessfulId = fold.lastSuccessfulId;
  let lapEnded = false;
  for (const row of rows) {
    const miss = row.ownerMissing;
    if (miss) {
      consecutiveOwnerReverts += 1;
      if (consecutiveOwnerReverts >= revertLimit) {
        lapEnded = true;
        break;
      }
      continue;
    }
    consecutiveOwnerReverts = 0;
    lastSuccessfulId = row.agentId;
  }
  return { fold: { consecutiveOwnerReverts, lastSuccessfulId }, lapEnded };
}

function decodeAddressReturn(data: Hex): Address | null {
  if (data.length < 66) return null;
  const word = (`0x${data.slice(-40)}`) as Address;
  return word;
}

function stateRpcUrl(env: Record<string, string | undefined>, key: keyof typeof DEFAULT_STATE_RPC): string {
  const fromEnv = env[key]?.trim();
  return fromEnv || DEFAULT_STATE_RPC[key]!;
}

export type Erc8004StateIndexDeps = {
  now: () => number;
  env: Record<string, string | undefined>;
  getCheckpoint: (scope: string) => Promise<bigint | null>;
  getCheckpointMeta: (scope: string) => Promise<{ lastBlock: bigint; lastCursor: string | null; supplyEstimate: bigint | null } | null>;
  setCheckpoint: (
    scope: string,
    lastBlock: bigint,
    supplyEstimate?: bigint,
    lastCursor?: string | null,
  ) => Promise<void>;
  aggregate3: (
    client: PublicClient,
    ids: bigint[],
    mode: "full" | "wallet",
  ) => Promise<{ rows: StateBatchRow[]; ownerResults: { success: boolean; returnData: Hex }[]; walletResults: { success: boolean; returnData: Hex }[] | null }>;
  makeClient: (target: Erc8004StateTarget, rpcUrl: string) => PublicClient;
  applyChain: (chainId: number, changes: Erc8004ChainAgentChanges, options?: { shouldStop?: () => boolean }) => Promise<void>;
  applyWallets: (pairs: { agentId: bigint; wallet: Address }[], options?: { shouldStop?: () => boolean }) => Promise<void>;
};

function defaultMakeClient(target: Erc8004StateTarget, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: target.viemChain,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }),
  });
}

async function defaultAggregate3(
  client: PublicClient,
  ids: bigint[],
  mode: "full" | "wallet",
): Promise<{
  rows: StateBatchRow[];
  ownerResults: { success: boolean; returnData: Hex }[];
  walletResults: { success: boolean; returnData: Hex }[] | null;
}> {
  const registry = ERC8004_ADDRESSES.identityRegistry;
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = [];
  for (const id of ids) {
    if (mode === "full") {
      calls.push({
        target: registry,
        allowFailure: true,
        callData: encodeFunctionData({ abi: identityStateAbi, functionName: "ownerOf", args: [id] }),
      });
    }
    calls.push({
      target: registry,
      allowFailure: true,
      callData: encodeFunctionData({ abi: identityStateAbi, functionName: "getAgentWallet", args: [id] }),
    });
  }
  const raw = (await client.readContract({
    address: MULTICALL3_ADDRESS,
    abi: aggregate3Abi,
    functionName: "aggregate3",
    args: [calls],
  })) as readonly { success: boolean; returnData: Hex }[];

  const ownerResults: { success: boolean; returnData: Hex }[] = [];
  const walletResults: { success: boolean; returnData: Hex }[] = [];
  if (mode === "full") {
    for (let i = 0; i < ids.length; i++) {
      ownerResults.push(raw[i * 2]!);
      walletResults.push(raw[i * 2 + 1]!);
    }
  } else {
    for (let i = 0; i < ids.length; i++) walletResults.push(raw[i]!);
  }
  const rows = foldStateMulticallBatch(ids, ownerResults, walletResults, mode);
  return { rows, ownerResults, walletResults: walletResults.length ? walletResults : null };
}

function rowsToChanges(rows: readonly StateBatchRow[], mode: "full" | "wallet"): Erc8004ChainAgentChanges | null {
  if (mode !== "full") return null;
  const changes: Erc8004ChainAgentChanges = { owners: [], wallets: [], burned: [] };
  for (const row of rows) {
    if (row.ownerMissing || !row.owner) continue;
    changes.owners.push({ agentId: row.agentId, owner: row.owner.toLowerCase() });
    changes.wallets.push({ agentId: row.agentId, wallet: row.wallet ? row.wallet.toLowerCase() : null });
  }
  return changes;
}

function walletPairs(rows: readonly StateBatchRow[]): { agentId: bigint; wallet: Address }[] {
  return rows.filter((r) => r.wallet).map((r) => ({ agentId: r.agentId, wallet: r.wallet! }));
}

export type Erc8004StateIndexResult =
  | { chain: Erc8004StateTarget["caip2"]; status: "error"; error: string }
  | {
      chain: Erc8004StateTarget["caip2"];
      status: "ok";
      fromId: string;
      toId: string;
      idsRead: number;
      ownersWritten: number;
      walletsWritten: number;
      lap: number;
      supplyEstimate: string | null;
      lapComplete: boolean;
      caughtUp: boolean;
      partial: boolean;
      stoppedBy?: string;
    };

async function defaultGetCheckpointMeta(
  scope: string,
): Promise<{ lastBlock: bigint; lastCursor: string | null; supplyEstimate: bigint | null } | null> {
  const db = await import("@/lib/db/client").then((m) => m.getDb());
  if (!db) return null;
  const { indexerCheckpoints } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      lastBlock: indexerCheckpoints.lastBlock,
      lastCursor: indexerCheckpoints.lastCursor,
      supplyEstimate: indexerCheckpoints.chainTipAtRun,
    })
    .from(indexerCheckpoints)
    .where(eq(indexerCheckpoints.scope, scope))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { lastBlock: r.lastBlock, lastCursor: r.lastCursor ?? null, supplyEstimate: r.supplyEstimate ?? null };
}

export async function indexErc8004StateChain(
  target: Erc8004StateTarget,
  options?: {
    timeBudgetMs?: number;
    maxIds?: number;
    startedAt?: number;
    deps?: Partial<Erc8004StateIndexDeps>;
  },
): Promise<Erc8004StateIndexResult> {
  const env = options?.deps?.env ?? process.env;
  const now = options?.deps?.now ?? Date.now;
  const startedAt = options?.startedAt ?? now();
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_STATE_TIME_BUDGET_MS;
  const maxIdsEnv = env.ERC8004_STATE_MAX_IDS?.trim();
  const maxIds =
    options?.maxIds ??
    (maxIdsEnv && /^\d+$/.test(maxIdsEnv) ? Number(maxIdsEnv) : DEFAULT_STATE_MAX_IDS);
  const rpcUrl = stateRpcUrl(env, target.rpcEnv);
  const client = (options?.deps?.makeClient ?? defaultMakeClient)(target, rpcUrl);
  const scope = erc8004StateCheckpointScope(target.caip2);
  const getCheckpoint = options?.deps?.getCheckpoint ?? getIndexerCheckpoint;
  const getMeta = options?.deps?.getCheckpointMeta ?? defaultGetCheckpointMeta;
  const setCheckpoint =
    options?.deps?.setCheckpoint ??
    (async (s, lastBlock, supplyEstimate, lastCursor) => setIndexerCheckpoint(s, lastBlock, supplyEstimate, lastCursor));
  const aggregate3 = options?.deps?.aggregate3 ?? defaultAggregate3;
  const applyChain = options?.deps?.applyChain ?? applyErc8004ChainAgentChanges;
  const applyWallets = options?.deps?.applyWallets ?? upsertAgentWallets;

  const meta = await getMeta(scope);
  const cursor = meta?.lastBlock ?? (await getCheckpoint(scope)) ?? 0n;
  const lap = meta?.lastCursor ? Number.parseInt(meta.lastCursor, 10) || 0 : 0;
  let nextId = cursor === 0n ? 1n : cursor + 1n;
  const fromId = nextId;

  let fold: StateFoldState = { consecutiveOwnerReverts: 0, lastSuccessfulId: meta?.supplyEstimate ?? null };
  let idsRead = 0;
  let ownersWritten = 0;
  let walletsWritten = 0;
  let lapComplete = false;
  let stoppedBy: string | undefined;
  let lastWrittenId = cursor;

  const shouldStop = () => now() - startedAt >= timeBudgetMs;

  try {
    while (idsRead < maxIds) {
      if (shouldStop()) {
        stoppedBy = "time_budget";
        break;
      }
      const batchSize = Math.min(STATE_BATCH_SIZE, maxIds - idsRead);
      const ids: bigint[] = [];
      for (let i = 0; i < batchSize; i++) ids.push(nextId + BigInt(i));
      const { rows } = await aggregate3(client, ids, target.mode);
      const { fold: nextFold, lapEnded } = advanceStateFold(fold, rows, target.mode);
      fold = nextFold;

      const changes = rowsToChanges(rows.filter((r) => !r.ownerMissing), target.mode);
      if (changes && (changes.owners.length > 0 || changes.wallets.length > 0)) {
        await applyChain(target.chainId, changes, { shouldStop });
        ownersWritten += changes.owners.length;
        walletsWritten += changes.wallets.length;
      }
      const pairs = walletPairs(rows.filter((r) => !r.ownerMissing));
      if (target.mode === "wallet" && pairs.length > 0) {
        await applyWallets(pairs, { shouldStop });
        walletsWritten += pairs.length;
      }

      const lastInBatch = ids[ids.length - 1]!;
      lastWrittenId = lapEnded ? 0n : lastInBatch;
      await setCheckpoint(scope, lastWrittenId, fold.lastSuccessfulId ?? meta?.supplyEstimate ?? undefined, String(lap));

      idsRead += ids.length;
      nextId = lastInBatch + 1n;

      if (lapEnded) {
        lapComplete = true;
        await setCheckpoint(scope, 0n, fold.lastSuccessfulId ?? undefined, String(lap + 1));
        break;
      }

      if (ids.length < STATE_BATCH_SIZE) break;
    }
  } catch (error) {
    if (error instanceof DeadlineExceededError) stoppedBy = "write_deadline";
    else {
      const msg = error instanceof Error ? error.message : String(error);
      return { chain: target.caip2, status: "error", error: msg };
    }
  }

  logServerInfoSafe(
    "erc8004-state-indexer",
    `${target.caip2} ids=${fromId}-${lastWrittenId} read=${idsRead} owners=${ownersWritten} wallets=${walletsWritten} lap=${lapComplete ? lap + 1 : lap}`,
  );
  if (stoppedBy) logServerWarnSafe("erc8004-state-indexer.partial", `${target.caip2} stopped: ${stoppedBy}`);

  return {
    chain: target.caip2,
    status: "ok",
    fromId: fromId.toString(),
    toId: lastWrittenId.toString(),
    idsRead,
    ownersWritten,
    walletsWritten,
    lap: lapComplete ? lap + 1 : lap,
    supplyEstimate: (fold.lastSuccessfulId ?? meta?.supplyEstimate)?.toString() ?? null,
    lapComplete,
    caughtUp: lapComplete,
    partial: stoppedBy !== undefined,
    ...(stoppedBy ? { stoppedBy } : {}),
  };
}

export async function indexErc8004StateChains(
  options?: {
    timeBudgetMs?: number;
    maxIds?: number;
    startedAt?: number;
    deps?: Partial<Erc8004StateIndexDeps>;
  },
): Promise<Erc8004StateIndexResult[]> {
  const now = options?.deps?.now ?? Date.now;
  const startedAt = options?.startedAt ?? now();
  const shared = { ...options, startedAt, deps: options?.deps };
  const settled = await Promise.allSettled(ERC8004_STATE_TARGETS.map((t) => indexErc8004StateChain(t, shared)));
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          chain: ERC8004_STATE_TARGETS[i]!.caip2,
          status: "error" as const,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}