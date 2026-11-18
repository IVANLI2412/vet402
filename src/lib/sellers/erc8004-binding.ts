// ============================================================
// /sellers/[host] — ERC-8004 agents on Base bound to this seller's payTo addresses.
// Match rule matches observatory erc8004-match (exact lowercase address equality).
// DB only on the request path. Read failures return unavailable, not an empty match list.
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { sellerHostSql } from "@/lib/sellers/host";

export const SELLER_ERC8004_MAX_LISTED = 20;

export type SellerErc8004MatchedBy = "wallet_confirmed" | "owner_only";

export type SellerErc8004BindingRow = {
  agentId: string;
  payTo: string;
  matchedBy: SellerErc8004MatchedBy;
  purchases: number;
  settled: number;
};

export type SellerErc8004RawMatch = {
  matchKind: "owner" | "agent_wallet";
  agentId: string;
  payTo: string;
  purchases: number;
  settled: number;
};

export type SellerErc8004Binding =
  | { status: "ok"; agents: SellerErc8004BindingRow[]; totalAgents: number; readAt: string }
  | { status: "none"; readAt: string }
  | { status: "unavailable"; reason: string; readAt: string };

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || compareBytes(a, b);
}

/** ISO week YYYY-Www for the Monday at the start of the last fully ended ISO week (UTC). */
export function lastCompleteIsoWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  const mondayThisWeek = new Date(d);
  mondayThisWeek.setUTCDate(d.getUTCDate() - day + 1);
  const mondayLastComplete = new Date(mondayThisWeek.getTime() - 7 * 86_400_000);
  const thursday = new Date(mondayLastComplete);
  thursday.setUTCDate(mondayLastComplete.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(Date.UTC(isoYear, 0, 4 - jan4Day + 1));
  const ww = Math.floor((mondayLastComplete.getTime() - mondayWeek1.getTime()) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(ww).padStart(2, "0")}`;
}

export function erc8004WeeklyHref(agentId: string, week: string): string {
  return `/api/v1/observatory/erc8004/weekly/${encodeURIComponent(agentId)}?week=${encodeURIComponent(week)}`;
}

/**
 * Dedupe owner vs agent_wallet per (agentId, payTo), order wallet_confirmed first, cap the list.
 */
export function finalizeSellerErc8004Agents(
  rows: readonly SellerErc8004RawMatch[],
  maxListed = SELLER_ERC8004_MAX_LISTED,
): { agents: SellerErc8004BindingRow[]; totalAgents: number } {
  const best = new Map<string, SellerErc8004RawMatch>();
  for (const row of rows) {
    const key = `${row.agentId}\0${row.payTo}`;
    const prev = best.get(key);
    if (!prev || (prev.matchKind === "owner" && row.matchKind === "agent_wallet")) best.set(key, row);
  }
  const all = [...best.values()].map((r) => ({
    agentId: r.agentId,
    payTo: r.payTo,
    matchedBy: (r.matchKind === "agent_wallet" ? "wallet_confirmed" : "owner_only") as SellerErc8004MatchedBy,
    purchases: r.purchases,
    settled: r.settled,
  }));
  all.sort(
    (a, b) =>
      (a.matchedBy === "wallet_confirmed" ? 0 : 1) - (b.matchedBy === "wallet_confirmed" ? 0 : 1) ||
      b.purchases - a.purchases ||
      compareBytes(a.payTo, b.payTo) ||
      compareIds(a.agentId, b.agentId),
  );
  return { agents: all.slice(0, maxListed), totalAgents: all.length };
}

export const SELLER_ERC8004_BINDING_SQL = `
WITH paid AS (
  SELECT lower(pu.pay_to) AS pay_to,
         count(*)::int AS purchases,
         count(*) FILTER (WHERE pu.status = 'settled')::int AS settled
  FROM x402_l1_purchases pu
  JOIN x402_endpoints e ON e.id = pu.endpoint_id
  WHERE pu.pay_to IS NOT NULL AND {{host_filter}} = {{host}}
  GROUP BY lower(pu.pay_to)
),
m AS (
  SELECT 'owner' AS match_kind, oa.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN owner_agents oa ON oa.owner = paid.pay_to
  UNION ALL
  SELECT 'agent_wallet' AS match_kind, a.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN agents a ON a.wallet = paid.pay_to AND a.chain_id = 8453
)
SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM (
  SELECT match_kind, agent_id::text AS agent_id, pay_to, purchases, settled
  FROM m
) t
`;

function sellerBindingQuery(host: string) {
  const HOST_SQL = sellerHostSql(sql`e.resource_key`);
  const parts = SELLER_ERC8004_BINDING_SQL.split(/\{\{(host_filter|host)\}\}/);
  return sql.join(
    parts.map((p, i) => {
      if (i % 2 === 1) return p === "host_filter" ? HOST_SQL : sql`${host.toLowerCase()}`;
      return sql.raw(p);
    }),
  );
}

function rawMatchesOf(top: unknown): SellerErc8004RawMatch[] {
  const arr = (typeof top === "string" ? JSON.parse(top) : (top ?? [])) as Record<string, unknown>[];
  return arr.map((r) => ({
    matchKind: r.match_kind === "agent_wallet" ? "agent_wallet" : "owner",
    agentId: String(r.agent_id),
    payTo: String(r.pay_to),
    purchases: Number(r.purchases),
    settled: Number(r.settled),
  }));
}

export async function readSellerErc8004Binding(host: string): Promise<SellerErc8004Binding> {
  const readAt = new Date().toISOString();
  const db = getDb();
  if (!db) return { status: "unavailable", reason: "database_not_configured", readAt };
  try {
    const row = rowsOf(await db.execute(sellerBindingQuery(host)))[0];
    if (!row) return { status: "unavailable", reason: "query_failed", readAt };
    const { agents, totalAgents } = finalizeSellerErc8004Agents(rawMatchesOf(row.rows));
    if (totalAgents === 0) return { status: "none", readAt };
    return { status: "ok", agents, totalAgents, readAt };
  } catch (error) {
    if (isMissingSchemaError(error)) return { status: "unavailable", reason: "schema_not_ready", readAt };
    logServerErrorSafe("sellers.erc8004-binding", error);
    return { status: "unavailable", reason: "query_failed", readAt };
  }
}