import { and, eq } from "drizzle-orm";
import { type Address, decodeEventLog, isAddress, type Hex } from "viem";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { createDeadline, DeadlineExceededError } from "@/lib/util/deadline";
import { getLogScanClient, getPublicClient } from "@/lib/chain/client";
import { ERC8004_ADDRESSES, IDENTITY_REGISTRY_FROM_BLOCK } from "@/lib/chain/config";
import { ERC8004_INDEXED_CHAIN } from "@/lib/observatory/erc8004-match";
import { NEW_FEEDBACK_EVENT, reputationRegistryAbi } from "@/lib/chain/erc8004";
import { getDb } from "@/lib/db/client";
import { feedbackEvents } from "@/lib/db/schema";

export const ERC8004_CHECK_CHAIN = ERC8004_INDEXED_CHAIN;
export const ERC8004_CHECK_CHAIN_ID = 8453;

/** Cap readFeedback probes when resolving feedbackIndex without client. */
export const RESOLVE_CLIENT_MAX_READS = 25;
export const RESOLVE_CLIENT_DEADLINE_MS = 8_000;

export type ResolveClientForIndexResult =
  | { status: "found"; client: Address }
  | { status: "not_found" }
  | { status: "ambiguous" };

export type FindFeedbackLogResult =
  | { kind: "found"; log: FeedbackLogSlice }
  | { kind: "not_found" }
  | { kind: "deadline" };

export type FeedbackLogSlice = {
  clientAddress: Address;
  feedbackIndex: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
  blockNumber: bigint;
  txHash: Hex;
};

export type RegistryRpc = {
  readContract: (args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
  getTransactionReceipt?: (args: { hash: Hex }) => Promise<{
    blockNumber: bigint;
    logs: readonly {
      address?: string;
      topics: readonly Hex[];
      data: Hex;
    }[];
  }>;
};

export type RegistryReaders = {
  publicClient?: RegistryRpc;
  logClient?: ReturnType<typeof getLogScanClient>;
  loadTxHashes?: (chainId: number, agentId: bigint, client: Address) => Promise<readonly Hex[]>;
  getClients?: (agentId: bigint) => Promise<readonly Address[]>;
};

export function parseErc8004Chain(raw: string | null): { ok: true; caip: string; chainId: number } | { ok: false } {
  const trimmed = (raw ?? ERC8004_CHECK_CHAIN).trim();
  if (trimmed !== ERC8004_CHECK_CHAIN) return { ok: false };
  return { ok: true, caip: ERC8004_CHECK_CHAIN, chainId: ERC8004_CHECK_CHAIN_ID };
}

export async function resolveClientForIndex(
  agentId: bigint,
  feedbackIndex: bigint,
  chainId: number,
  client?: RegistryRpc,
  readers?: RegistryReaders,
): Promise<ResolveClientForIndexResult> {
  const rpc: RegistryRpc = client ?? (getPublicClient(chainId) as RegistryRpc);
  const deadline = createDeadline(RESOLVE_CLIENT_DEADLINE_MS);
  const clients = readers?.getClients
    ? await readers.getClients(agentId)
    : ((await rpc.readContract({
        address: ERC8004_ADDRESSES.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: "getClients",
        args: [agentId],
      })) as readonly Address[]);
  const matches: Address[] = [];
  let reads = 0;
  for (const candidate of clients) {
    deadline.throwIfExpired("resolveClientForIndex");
    if (reads >= RESOLVE_CLIENT_MAX_READS) return { status: "ambiguous" };
    reads += 1;
    try {
      await rpc.readContract({
        address: ERC8004_ADDRESSES.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: "readFeedback",
        args: [agentId, candidate, feedbackIndex],
      });
      matches.push(candidate);
      if (matches.length >= 2) return { status: "ambiguous" };
    } catch {
      // not this client
    }
  }
  if (matches.length === 1) return { status: "found", client: matches[0] };
  return { status: "not_found" };
}

export async function resolveFeedbackIndex(
  agentId: bigint,
  client: Address,
  chainId: number,
  clientRpc?: RegistryRpc,
): Promise<bigint | null> {
  const rpc: RegistryRpc = clientRpc ?? (getPublicClient(chainId) as RegistryRpc);
  try {
    const last = (await rpc.readContract({
      address: ERC8004_ADDRESSES.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: "getLastIndex",
      args: [agentId, client],
    })) as bigint;
    return last > 0n ? last : null;
  } catch {
    return null;
  }
}

export async function readOnChainFeedbackMeta(
  agentId: bigint,
  client: Address,
  feedbackIndex: bigint,
  chainId: number,
  clientRpc?: RegistryRpc,
) {
  const rpc: RegistryRpc = clientRpc ?? (getPublicClient(chainId) as RegistryRpc);
  const raw = (await rpc.readContract({
    address: ERC8004_ADDRESSES.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: "readFeedback",
    args: [agentId, client, feedbackIndex],
  })) as readonly [bigint, number, string, string, boolean];
  const [value, valueDecimals, tag1, tag2, isRevoked] = raw;
  return { value, valueDecimals: Number(valueDecimals), tag1, tag2, isRevoked };
}

async function defaultLoadTxHashes(chainId: number, agentId: bigint, client: Address): Promise<readonly Hex[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({ txHash: feedbackEvents.txHash })
    .from(feedbackEvents)
    .where(
      and(eq(feedbackEvents.chainId, chainId), eq(feedbackEvents.agentId, agentId), eq(feedbackEvents.clientAddress, client.toLowerCase())),
    );
  return [...new Set(rows.map((r) => r.txHash as Hex))];
}

export async function findFeedbackLog(
  agentId: bigint,
  client: Address,
  feedbackIndex: bigint,
  chainId: number,
  readers?: RegistryReaders,
): Promise<FindFeedbackLogResult> {
  const rpc: RegistryRpc = readers?.publicClient ?? (getPublicClient(chainId) as RegistryRpc);
  const loadHashes = readers?.loadTxHashes ?? defaultLoadTxHashes;
  const hashes = await loadHashes(chainId, agentId, client);
  for (const hash of hashes) {
    const slice = await decodeFeedbackFromTx(rpc, hash, agentId, client, feedbackIndex);
    if (slice) return { kind: "found", log: slice };
  }
  const logClient = readers?.logClient ?? getLogScanClient(chainId);
  let logs: {
    args?: Record<string, unknown>;
    blockNumber?: bigint;
    transactionHash?: Hex;
  }[];
  try {
    logs = (await getLogsChunked(
      logClient,
      {
        address: ERC8004_ADDRESSES.reputationRegistry,
        event: NEW_FEEDBACK_EVENT,
        args: { agentId, clientAddress: client },
        fromBlock: IDENTITY_REGISTRY_FROM_BLOCK,
        toBlock: "latest",
      },
      undefined,
      2,
      { deadlineMs: 12_000, delayMs: 0 },
    )) as typeof logs;
  } catch (error) {
    if (error instanceof DeadlineExceededError) return { kind: "deadline" };
    throw error;
  }
  for (const log of logs) {
    const idx = toBigInt(log.args?.feedbackIndex);
    if (idx !== feedbackIndex) continue;
    return { kind: "found", log: logSliceFromArgs(client, log) };
  }
  return { kind: "not_found" };
}

async function decodeFeedbackFromTx(
  rpc: RegistryRpc,
  txHash: Hex,
  agentId: bigint,
  client: Address,
  feedbackIndex: bigint,
): Promise<FeedbackLogSlice | null> {
  if (!rpc.getTransactionReceipt) return null;
  let receipt;
  try {
    receipt = await rpc.getTransactionReceipt({ hash: txHash });
  } catch {
    return null;
  }
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== ERC8004_ADDRESSES.reputationRegistry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [NEW_FEEDBACK_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as Record<string, unknown>;
      if (toBigInt(args.agentId) !== agentId) continue;
      if (String(args.clientAddress).toLowerCase() !== client.toLowerCase()) continue;
      if (toBigInt(args.feedbackIndex) !== feedbackIndex) continue;
      return {
        clientAddress: client,
        feedbackIndex,
        value: toBigInt(args.value),
        valueDecimals: Number(args.valueDecimals ?? 0),
        tag1: String(args.tag1 ?? ""),
        tag2: String(args.tag2 ?? ""),
        endpoint: String(args.endpoint ?? ""),
        feedbackURI: String(args.feedbackURI ?? ""),
        feedbackHash: args.feedbackHash as Hex,
        blockNumber: receipt.blockNumber,
        txHash,
      };
    } catch {
      // not this log
    }
  }
  return null;
}

function logSliceFromArgs(
  client: Address,
  log: { args?: Record<string, unknown>; blockNumber?: bigint; transactionHash?: Hex },
): FeedbackLogSlice {
  const args = log.args ?? {};
  return {
    clientAddress: client,
    feedbackIndex: toBigInt(args.feedbackIndex),
    value: toBigInt(args.value),
    valueDecimals: Number(args.valueDecimals ?? 0),
    tag1: String(args.tag1 ?? ""),
    tag2: String(args.tag2 ?? ""),
    endpoint: String(args.endpoint ?? ""),
    feedbackURI: String(args.feedbackURI ?? ""),
    feedbackHash: args.feedbackHash as Hex,
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash ?? ("0x" as Hex),
  };
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(v);
  if (typeof v === "string" && v) return BigInt(v);
  return 0n;
}

export function parseClientParam(raw: string | null): Address | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  return isAddress(trimmed) ? (trimmed as Address) : null;
}

export function parseFeedbackIndexParam(raw: string | null): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const n = BigInt(raw.trim());
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function parseAgentIdParam(raw: string | null): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const n = BigInt(raw.trim());
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}