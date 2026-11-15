import { sql } from "drizzle-orm";
import { BASE_BLOCK_TIME_SCHEDULE, timestampOfBlock } from "@/lib/chain/block-clock";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { getIndexerCheckpoint } from "@/lib/db/owner-index";
import { classifySellerRow } from "@/lib/sellers/fix-modes";
import { sellerHostSql } from "@/lib/sellers/host";
import { isExcludedPayTo, refundStats, type RefundPurchase, type RefundStats, type RefundTransfer } from "@/lib/sellers/refunds";
import { readSellerFailureDays, sellerRowColumnsSql, toRowFacts } from "@/lib/sellers/reader";

const SCOPE = "payer_refunds:eip155:8453";

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

async function readThrough(db: Db): Promise<string | null> {
  const checkpoint = await getIndexerCheckpoint(SCOPE);
  if (checkpoint === null) return null;
  const secs = timestampOfBlock(BASE_BLOCK_TIME_SCHEDULE, checkpoint);
  return new Date(secs * 1000).toISOString();
}

const BASE_ROW = sql`coalesce(pu.network, '') IN ('eip155:8453', 'base', '')`;

function mapTransfer(row: Record<string, unknown>): RefundTransfer {
  return {
    chain: String(row.chain),
    txHash: String(row.tx_hash),
    logIndex: Number(row.log_index),
    from: String(row.from_address).toLowerCase(),
    to: String(row.to_address).toLowerCase(),
    amount: String(row.amount),
    blockTime: new Date(String(row.block_time)).toISOString(),
  };
}

async function loadRefundPurchases(db: Db, extraWhere: ReturnType<typeof sql>): Promise<RefundPurchase[]> {
  const purchaseRows = rowsOf(
    await db.execute(sql`
      SELECT pu.id::text AS id, ${sellerHostSql(sql`e.resource_key`)} AS host, ${sellerRowColumnsSql}
      FROM x402_l1_purchases pu
      JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.status = 'settled' AND pu.network IS NOT NULL AND pu.pay_to IS NOT NULL
        ${extraWhere}
    `),
  );
  const endpointIds = [...new Set(purchaseRows.map((r) => String(r.endpoint_id)))];
  const failureDays = await readSellerFailureDays(db, endpointIds);

  const out: RefundPurchase[] = [];
  for (const row of purchaseRows) {
    const payTo = String(row.pay_to ?? "").toLowerCase();
    if (!payTo || isExcludedPayTo(payTo)) continue;
    const facts = toRowFacts(row);
    const days = failureDays.get(facts.endpointId);
    const classified = classifySellerRow(facts, { sellerFailureDays: days ? [...days] : [] });
    const sellerSide = classified.bucket === "seller";
    out.push({
      id: String(row.id),
      endpointId: facts.endpointId,
      host: String(row.host ?? ""),
      status: String(row.status),
      network: String(row.network ?? ""),
      payer: String(row.payer ?? "").toLowerCase(),
      payTo,
      amountUnits: String(row.amount_units ?? "0"),
      attemptedAt: facts.attemptedAt,
      httpStatusPaid: row.http_status_paid === null || row.http_status_paid === undefined ? null : Number(row.http_status_paid),
      payloadNonEmpty:
        row.payload_non_empty === null || row.payload_non_empty === undefined
          ? undefined
          : Boolean(row.payload_non_empty),
      sellerSide,
      txHash: facts.txHash,
    });
  }
  return out;
}

/** payTo の集合に払った購入を、ホストをまたいで全部読み、その payTo からの送金と合わせて payTo ごとに数える。 */
async function statsForPayTos(db: Db, payTos: string[], readThrough: string | null): Promise<RefundStats> {
  const kept = [...new Set(payTos.map((p) => p.toLowerCase()).filter((p) => p && !isExcludedPayTo(p)))];
  if (kept.length === 0) return refundStats([], [], readThrough, []);
  const list = sql.join(kept.map((p) => sql`${p}::text`), sql`, `);
  const purchases = await loadRefundPurchases(db, sql` AND lower(pu.pay_to) IN (${list})`);
  const transferRows = rowsOf(
    await db.execute(sql`
      SELECT chain, tx_hash, log_index, from_address, to_address, amount, block_time
      FROM x402_payer_refund_transfers
      WHERE lower(from_address) IN (${list})
    `),
  );
  const transfers = transferRows.map(mapTransfer).filter((t) => !isExcludedPayTo(t.from));
  return refundStats(purchases, transfers, readThrough, kept);
}

/**
 * 売り手ページ用。そのホストの購入が払った payTo ごとの数字（payTo 単位・ホストに振り分けない）。
 * 表がまだ無い（42P01）ときは null。
 */
export async function readSellerRefundStats(
  db: Db,
  filter: { host: string } | { payTo: string },
): Promise<RefundStats | null> {
  try {
    const read_through = await readThrough(db);
    if ("payTo" in filter) return await statsForPayTos(db, [filter.payTo], read_through);
    const HOST_SQL = sellerHostSql(sql`e.resource_key`);
    const rows = rowsOf(
      await db.execute(sql`
        SELECT DISTINCT lower(pu.pay_to) AS pay_to
        FROM x402_l1_purchases pu
        JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE pu.status = 'settled' AND pu.pay_to IS NOT NULL AND ${BASE_ROW}
          AND ${HOST_SQL} = ${filter.host.toLowerCase()}::text
      `),
    );
    return await statsForPayTos(db, rows.map((r) => String(r.pay_to)), read_through);
  } catch (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
}

/** 判定 API 用（まだ結線しない）: 1つの payTo の数字。 */
export async function readPayToRefundStats(db: Db, payTo: string): Promise<RefundStats | null> {
  return readSellerRefundStats(db, { payTo });
}
