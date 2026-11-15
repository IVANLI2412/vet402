import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { EVM_INDEX_CHAINS } from "@/lib/settlements/index-evm";
import { SOLANA_CHECKPOINT_SCOPE_PREFIX } from "@/lib/settlements/index-solana";
import { XRPL_CHECKPOINT_SCOPE_PREFIX } from "@/lib/settlements/index-xrpl";
import { SOLANA_MAINNET_CAIP2 } from "./sol402-payer";
import { XRPL_MAINNET_CAIP2 } from "./xrpl402-payer";
import { publicChainLabel } from "./chains";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { toIsoUtc } from "@/lib/util/iso-utc";

export const SETTLEMENT_INDEX_ABOUT =
  "lastReadAt is when vet402's own settlements index last saved its read position for that chain. settlements30d counts settlements that index found in the last 30 days (source chain_index, by block time). The index reads transfers to payTo addresses listed in the catalogs vet402 reads, so the count leaves out other x402 settlements on that chain. A chain with status never_read has no saved read position and carries no read time. readAt is when these figures were read from the database, cached up to 1 hour.";

export type SettlementIndexChainRow = {
  chain: string;
  label: string;
  lastReadAt: string | null;
  settlements30d: number;
  lastSettlementAt: string | null;
  status: "read" | "never_read";
};

export type SettlementIndexSummary =
  | { status: "ok"; byChain: SettlementIndexChainRow[]; readAt: string; about: string }
  | { status: "unavailable"; reason: "read_failed" | "timeout"; readAt: string };

const INDEX_CHAINS = [
  ...EVM_INDEX_CHAINS.map((c) => c.caip2),
  SOLANA_MAINNET_CAIP2,
  XRPL_MAINNET_CAIP2,
] as const;

function chainForCheckpointScope(scope: string): string | null {
  if (scope.startsWith(SOLANA_CHECKPOINT_SCOPE_PREFIX)) return SOLANA_MAINNET_CAIP2;
  if (scope.startsWith(XRPL_CHECKPOINT_SCOPE_PREFIX)) return XRPL_MAINNET_CAIP2;
  if (scope.startsWith("settlements:")) return scope.slice("settlements:".length);
  return null;
}

export function buildSettlementIndexByChain(input: {
  checkpoints: readonly { scope: string; updatedAt: Date | string }[];
  counts: readonly { chain: string; settlements30d: number; lastSettlementAt: Date | string | null }[];
}): SettlementIndexChainRow[] {
  const lastReadByChain = new Map<string, string>();
  for (const cp of input.checkpoints) {
    const chain = chainForCheckpointScope(cp.scope);
    if (!chain) continue;
    const at = typeof cp.updatedAt === "string" ? cp.updatedAt : toIsoUtc(cp.updatedAt) ?? "";
    if (!at) continue;
    const prev = lastReadByChain.get(chain);
    if (!prev || at > prev) lastReadByChain.set(chain, at);
  }
  const countByChain = new Map(input.counts.map((c) => [c.chain, c]));
  return INDEX_CHAINS.map((chain) => {
    const lastReadAt = lastReadByChain.get(chain) ?? null;
    const row = countByChain.get(chain);
    const settlements30d = row?.settlements30d ?? 0;
    const lastSettlementAt = row?.lastSettlementAt
      ? typeof row.lastSettlementAt === "string"
        ? row.lastSettlementAt
        : toIsoUtc(row.lastSettlementAt)
      : null;
    return {
      chain,
      label: publicChainLabel(chain),
      lastReadAt,
      settlements30d,
      lastSettlementAt,
      status: lastReadAt ? "read" : "never_read",
    };
  });
}

/** db は試験の差し替え口（既定は getDb()）。 */
export async function readSettlementIndexStatus(
  db: { execute: (query: import("drizzle-orm").SQL) => Promise<unknown> } | null = getDb(),
): Promise<SettlementIndexSummary> {
  const readAt = new Date().toISOString();
  if (!db) return { status: "unavailable", reason: "read_failed", readAt };
  try {
    const cpRaw = await db.execute(sql`
      SELECT scope, updated_at AS updated_at
      FROM indexer_checkpoints
      WHERE scope IN (${sql.join(
        EVM_INDEX_CHAINS.map((c) => sql`${`settlements:${c.caip2}`}`),
        sql`, `,
      )})
         OR scope LIKE ${SOLANA_CHECKPOINT_SCOPE_PREFIX + "%"}
         OR scope LIKE ${XRPL_CHECKPOINT_SCOPE_PREFIX + "%"}`);
    const cpRows = (Array.isArray(cpRaw) ? cpRaw : ((cpRaw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    const checkpoints = cpRows.map((r) => ({
      scope: String(r.scope),
      updatedAt: new Date(String(r.updated_at)),
    }));
    const countRaw = await db.execute(sql`
      SELECT chain, count(*)::int AS n, max(block_time) AS last_settlement
      FROM settlements
      WHERE source = 'chain_index'
        AND coalesce(block_time, observed_at) >= now() - interval '30 days'
      GROUP BY chain`);
    const countRows = (Array.isArray(countRaw) ? countRaw : ((countRaw as { rows?: unknown[] }).rows ?? [])) as Record<
      string,
      unknown
    >[];
    const counts = countRows.map((r) => ({
      chain: String(r.chain),
      settlements30d: Number(r.n ?? 0),
      lastSettlementAt: r.last_settlement ? new Date(String(r.last_settlement)) : null,
    }));
    return {
      status: "ok",
      byChain: buildSettlementIndexByChain({ checkpoints, counts }),
      readAt,
      about: SETTLEMENT_INDEX_ABOUT,
    };
  } catch (error) {
    logServerErrorSafe("settlement_index_status", error);
    return { status: "unavailable", reason: "read_failed", readAt };
  }
}

class SettlementIndexUnavailable extends Error {
  constructor(readonly summary: SettlementIndexSummary) {
    super("settlement index unavailable");
  }
}

type CacheFn = typeof unstable_cache;

export function makeSettlementIndexCachedReader(
  cache: CacheFn,
  read: () => Promise<SettlementIndexSummary> = readSettlementIndexStatus,
): () => Promise<SettlementIndexSummary> {
  const inner = cache(
    async (): Promise<SettlementIndexSummary> => {
      const summary = await read();
      if (summary.status !== "ok") throw new SettlementIndexUnavailable(summary);
      return summary;
    },
    ["observatory:settlement-index:v1"],
    { revalidate: 3600, tags: ["observatory", "settlements"] },
  );
  return async () => {
    try {
      return await inner();
    } catch (error) {
      if (error instanceof SettlementIndexUnavailable) return error.summary;
      logServerErrorSafe("settlement_index_cache", error);
      const readAt = new Date().toISOString();
      return { status: "unavailable", reason: "read_failed", readAt };
    }
  };
}

let cachedSettlementIndex = makeSettlementIndexCachedReader(unstable_cache);

export function __setSettlementIndexCacheForTests(
  cache: CacheFn | null,
  read: () => Promise<SettlementIndexSummary> = readSettlementIndexStatus,
): void {
  cachedSettlementIndex = makeSettlementIndexCachedReader(cache ?? unstable_cache, read);
}

export function getSettlementIndexCached(): Promise<SettlementIndexSummary> {
  return cachedSettlementIndex();
}