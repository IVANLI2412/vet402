// Base USDC の payTo → vet402 支払元 への返金転送を索引する。cron 専用。頁から import しない。
import { sql } from "drizzle-orm";
import type { Address } from "viem";
import { parseAbiItem } from "viem";
import { BASE_BLOCK_TIME_SCHEDULE, firstBlockAtOrAfter } from "@/lib/chain/block-clock";
import { getLogScanClient } from "@/lib/chain/client";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import { x402PayerRefundTransfers } from "@/lib/db/schema";
import { operatorPayToDenylist } from "@/lib/observatory/operator";
import { isExcludedPayTo } from "@/lib/sellers/refunds";
import { logServerWarnSafe } from "@/lib/util/log-safe";
import { BASE_PAYER_PERIODS } from "@/lib/sellers/payers";
import { DeadlineExceededError } from "@/lib/util/deadline";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SCOPE = "payer_refunds:eip155:8453";
let operatorListWarned = false;
const CAIP2 = "eip155:8453";
const DEFAULT_MAX_BLOCKS = 300_000n;
/** Same confirmation depth as Base in index-evm (2026-11-15 C4). */
const BASE_CONFIRMATIONS = 32n;
const BASE_SUB_WINDOW = 20_000n;
const PAYER_START = firstBlockAtOrAfter(BASE_BLOCK_TIME_SCHEDULE, Math.floor(new Date("2026-08-14T00:00:00.000Z").getTime() / 1000));

type LogClient = Pick<ReturnType<typeof getLogScanClient>, "getBlockNumber" | "getBlock" | "getLogs">;

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export type PayerRefundIndexSummary = {
  payers: number;
  payTos: number;
  fromBlock?: string;
  toBlock?: string;
  logs: number;
  stored: number;
  checkpoint: string | null;
  skipped?: string;
  cutOff?: boolean;
};

export async function indexPayerRefunds(options: {
  db?: NonNullable<ReturnType<typeof getDb>>;
  client?: LogClient;
  budgetMs?: number;
  now?: () => number;
  maxBlocksPerRun?: bigint;
  getLogs?: typeof getLogsChunked;
} = {}): Promise<PayerRefundIndexSummary> {
  const db = options.db ?? getDb();
  const summary: PayerRefundIndexSummary = { payers: 0, payTos: 0, logs: 0, stored: 0, checkpoint: null };
  if (!db) throw new Error("indexPayerRefunds: DATABASE_URL is not configured");

  const payers = BASE_PAYER_PERIODS.map((p) => p.address.toLowerCase());
  summary.payers = payers.length;

  const payTosQuery = () => sql`
    SELECT DISTINCT lower(pay_to) AS pay_to FROM x402_l1_purchases
    WHERE network IN ('eip155:8453', 'base')
      AND lower(payer) IN (${sql.join(payers.map((p) => sql`${p}::text`), sql`, `)})
  `;
  // status で絞らない: あとから settled になる行の payTo も取りこぼさない。資金補充先は vet402 payer ではないので集合に入らない。
  const payToRows = rowsOf<{ pay_to: string }>(await db.execute(payTosQuery()));
  if (operatorPayToDenylist().length === 0 && !operatorListWarned) {
    // The derived operator addresses live only in the L1 runner process, so this cron sees VET402_OPERATOR_PAYTO alone.
    operatorListWarned = true;
    logServerWarnSafe("sellers.refund-index", "VET402_OPERATOR_PAYTO is unset or empty, so no operator payTo is left out of the refund index");
  }
  const payTos = new Set(payToRows.map((r) => r.pay_to).filter((p) => !isExcludedPayTo(p)));
  summary.payTos = payTos.size;
  if (payTos.size === 0) return { ...summary, skipped: "no_paytos" };

  const mergePayTosFromDb = async (): Promise<boolean> => {
    const before = payTos.size;
    const rows = rowsOf<{ pay_to: string }>(await db.execute(payTosQuery()));
    for (const r of rows) {
      if (!isExcludedPayTo(r.pay_to)) payTos.add(r.pay_to);
    }
    summary.payTos = payTos.size;
    return payTos.size > before;
  };

  const client = options.client ?? getLogScanClient(8453);
  const latest = await client.getBlockNumber();
  const safeTip = latest > BASE_CONFIRMATIONS ? latest - BASE_CONFIRMATIONS : 0n;
  const checkpoint = await getIndexerCheckpoint(SCOPE);
  const fromBlock = checkpoint !== null ? checkpoint + 1n : PAYER_START;
  if (fromBlock > safeTip) {
    return { ...summary, skipped: "caught_up", fromBlock: String(fromBlock), toBlock: String(safeTip), checkpoint: checkpoint?.toString() ?? null };
  }
  const maxBlocks = options.maxBlocksPerRun ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks - 1n < safeTip ? fromBlock + maxBlocks - 1n : safeTip;
  summary.fromBlock = String(fromBlock);
  summary.toBlock = String(toBlock);

  const budgetMs = options.budgetMs ?? 120_000;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const subWindow = BASE_SUB_WINDOW;
  const getLogs = options.getLogs ?? getLogsChunked;

  let nextCheckpoint = fromBlock - 1n;
  let cutOff = false;
  const blockTimeCache = new Map<string, Date>();

  const blockTimeOf = async (block: bigint): Promise<Date> => {
    const key = block.toString();
    const hit = blockTimeCache.get(key);
    if (hit) return hit;
    const b = await client.getBlock({ blockNumber: block });
    const d = new Date(Number(b.timestamp) * 1000);
    blockTimeCache.set(key, d);
    return d;
  };

  type Raw = {
    transactionHash: string;
    logIndex: number;
    blockNumber: bigint;
    args: { from: Address; to: Address; value?: bigint };
  };

  const scanSubWindow = async (wFrom: bigint, wTo: bigint): Promise<boolean> => {
    let windowComplete = true;
    for (let i = 0; i < payers.length; i += 500) {
      if (now() - startedAt > budgetMs) {
        cutOff = true;
        return false;
      }
      const slice = payers.slice(i, i + 500) as Address[];
      let logs: unknown[];
      try {
        logs = await getLogs(
          client as Parameters<typeof getLogsChunked>[0],
          { address: BASE_USDC as Address, event: TRANSFER_EVENT, args: { to: slice }, fromBlock: wFrom, toBlock: wTo } as never,
          undefined,
          undefined,
          { deadlineMs: Math.max(5_000, budgetMs - (now() - startedAt)) },
        );
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          cutOff = true;
          return false;
        }
        throw error;
      }
      const raw = logs as Raw[];
      summary.logs += raw.length;
      for (const l of raw) {
        if (now() - startedAt > budgetMs) {
          cutOff = true;
          return false;
        }
        const from = l.args.from.toLowerCase();
        if (isExcludedPayTo(from) || !payTos.has(from)) continue;
        const to = l.args.to.toLowerCase();
        if (!payers.includes(to)) continue;
        const value = l.args.value;
        if (typeof value !== "bigint") {
          windowComplete = false;
          break;
        }
        const blockTime = await blockTimeOf(l.blockNumber);
        // A failed write throws: the checkpoint must not move past a transfer that was not stored.
        const ins = await db
          .insert(x402PayerRefundTransfers)
          .values({
            chain: CAIP2,
            txHash: l.transactionHash,
            logIndex: l.logIndex,
            fromAddress: from,
            toAddress: to,
            asset: BASE_USDC,
            amount: value.toString(),
            blockNumber: l.blockNumber,
            blockTime,
          })
          .onConflictDoNothing()
          .returning();
        if (ins.length > 0) summary.stored += 1;
      }
      if (cutOff || !windowComplete) break;
    }
    return windowComplete;
  };

  for (let wFrom = fromBlock; wFrom <= toBlock; wFrom += subWindow) {
    if (now() - startedAt > budgetMs) {
      cutOff = true;
      break;
    }
    const wTo = wFrom + subWindow - 1n < toBlock ? wFrom + subWindow - 1n : toBlock;
    let windowComplete = await scanSubWindow(wFrom, wTo);
    if (cutOff || !windowComplete) break;

    let grew = await mergePayTosFromDb();
    if (grew) {
      windowComplete = await scanSubWindow(wFrom, wTo);
      if (cutOff || !windowComplete) break;
      grew = await mergePayTosFromDb();
      if (grew) break;
    }

    nextCheckpoint = wTo;
    await setIndexerCheckpoint(SCOPE, wTo, latest);
    summary.checkpoint = wTo.toString();
  }

  if (nextCheckpoint >= fromBlock) {
    summary.checkpoint = nextCheckpoint.toString();
  } else if (checkpoint !== null) {
    summary.checkpoint = checkpoint.toString();
  }

  return cutOff ? { ...summary, cutOff: true } : summary;
}

export async function indexPayerRefundsOrSkip(
  options: Parameters<typeof indexPayerRefunds>[0] = {},
): Promise<PayerRefundIndexSummary> {
  try {
    return await indexPayerRefunds(options);
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { payers: 0, payTos: 0, logs: 0, stored: 0, checkpoint: null, skipped: "table_missing" };
    }
    throw error;
  }
}