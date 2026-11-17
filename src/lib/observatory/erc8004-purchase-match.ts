// DB から購入行と ERC-8004 の一致を読む（フィードバック API・週次まとめ用）。
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { erc8004AgentColumnSql } from "@/lib/observatory/erc8004-export-agent";
// 2026-11-17: l2 の材料は列ではなく raw_response_meta の中。存在しない列を読んで本番の feedback・weekly が 503 だった。
import { l2ReadingColumnsSql } from "@/lib/observatory/l2-check";
import type { PurchaseFeedbackRow } from "@/lib/observatory/erc8004-feedback";

const MATCH_KIND_SQL = `(
  SELECT CASE chosen.priority WHEN 1 THEN 'agent_wallet' ELSE 'owner' END
  FROM (
    SELECT a.agent_id, 1 AS priority
    FROM agents a
    WHERE a.chain_id = 8453 AND a.wallet IS NOT NULL AND a.wallet = lower(pu.pay_to)
    UNION ALL
    SELECT oa.agent_id, 2 AS priority
    FROM owner_agents oa
    WHERE oa.owner = lower(pu.pay_to)
  ) chosen
  ORDER BY chosen.priority, chosen.agent_id
  LIMIT 1
)`;

const PURCHASE_FEEDBACK_SELECT = `
  pu.id::text AS id,
  pu.attempted_at,
  e.resource_key,
  pu.network,
  pu.status,
  pu.amount_units,
  pu.spent_units,
  pu.tx_hash,
  pu.http_status_paid,
  pu.latency_ms,
  pu.l2_schema,
  ${l2ReadingColumnsSql("pu")},
  pu.pay_to,
  pu.payer,
  pu.payload_non_empty,
  (${erc8004AgentColumnSql("pu")}) AS erc8004_agent,
  (${MATCH_KIND_SQL}) AS erc8004_match_kind
`;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

function rowToPurchase(row: Record<string, unknown>): PurchaseFeedbackRow {
  return {
    id: String(row.id),
    attempted_at: row.attempted_at as Date | string,
    resource_key: String(row.resource_key),
    network: row.network === null || row.network === undefined ? null : String(row.network),
    status: String(row.status),
    amount_units: row.amount_units === null || row.amount_units === undefined ? null : String(row.amount_units),
    spent_units: row.spent_units === null || row.spent_units === undefined ? null : String(row.spent_units),
    tx_hash: row.tx_hash === null || row.tx_hash === undefined ? null : String(row.tx_hash),
    http_status_paid: row.http_status_paid === null || row.http_status_paid === undefined ? null : Number(row.http_status_paid),
    latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    l2_schema: row.l2_schema === null || row.l2_schema === undefined ? null : String(row.l2_schema),
    l2_detail: row.l2_detail,
    l2_body_head: row.l2_body_head === null || row.l2_body_head === undefined ? null : String(row.l2_body_head),
    l2_content_type: row.l2_content_type === null || row.l2_content_type === undefined ? null : String(row.l2_content_type),
    pay_to: row.pay_to === null || row.pay_to === undefined ? null : String(row.pay_to),
    payer: row.payer === null || row.payer === undefined ? null : String(row.payer),
    payload_non_empty: row.payload_non_empty === null || row.payload_non_empty === undefined ? null : Boolean(row.payload_non_empty),
    erc8004_agent: row.erc8004_agent === null || row.erc8004_agent === undefined ? null : String(row.erc8004_agent),
    erc8004_match_kind:
      row.erc8004_match_kind === null || row.erc8004_match_kind === undefined ? null : String(row.erc8004_match_kind),
  };
}

export async function readPurchaseForErc8004Feedback(
  db: NonNullable<ReturnType<typeof getDb>>,
  purchaseId: string,
): Promise<PurchaseFeedbackRow | null> {
  const raw = await db.execute(sql`
    SELECT ${sql.raw(PURCHASE_FEEDBACK_SELECT)}
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.id = ${purchaseId}::uuid
      AND pu.status NOT IN ('budget_denied', 'halted', 'request_error', 'in_flight')
    LIMIT 1
  `);
  const row = rowsOf(raw)[0];
  return row ? rowToPurchase(row) : null;
}

/** 安全な uuid バインド版（週次・一覧用）。 */
export async function readPurchasesForErc8004AgentWeek(
  db: NonNullable<ReturnType<typeof getDb>>,
  agentId: bigint,
  chainId: number,
  start: Date,
  end: Date,
): Promise<PurchaseFeedbackRow[]> {
  const agentFilter =
    chainId === 8453
      ? sql`(
          EXISTS (SELECT 1 FROM agents a WHERE a.chain_id = 8453 AND a.agent_id = ${agentId.toString()}::bigint AND a.wallet = lower(pu.pay_to))
          OR EXISTS (SELECT 1 FROM owner_agents oa WHERE oa.agent_id = ${agentId.toString()}::bigint AND oa.owner = lower(pu.pay_to))
        )`
      : sql`EXISTS (
          SELECT 1 FROM erc8004_chain_agents ca
          WHERE ca.chain_id = ${chainId}::bigint AND ca.agent_id = ${agentId.toString()}::bigint
            AND (ca.owner = lower(pu.pay_to) OR ca.wallet = lower(pu.pay_to))
        )`;

  const raw = await db.execute(sql`
    SELECT ${sql.raw(PURCHASE_FEEDBACK_SELECT)}
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.attempted_at >= ${start.toISOString()}::timestamptz
      AND pu.attempted_at < ${end.toISOString()}::timestamptz
      AND pu.status NOT IN ('budget_denied', 'halted', 'request_error', 'in_flight')
      AND ${agentFilter}
    ORDER BY pu.attempted_at ASC, pu.id ASC
  `);
  return rowsOf(raw).map(rowToPurchase);
}