// ============================================================
// GET /api/v1/observatory/delivery.csv の列の正典と DB 読み出し（2026-11-15）。
//
// settled の行だけを母集団に、delivery の 3 値（delivery-values.ts）と生の列を並べる。
// days の解釈は既定の export.csv route と同じ（ここに置き、route と試験が共有する）。
// ============================================================
import { sql } from "drizzle-orm";
import { type getDb } from "@/lib/db/client";

type AppDb = NonNullable<ReturnType<typeof getDb>>;
import { heldReasonSql } from "@/lib/observatory/delivery";
import {
  DELIVERY_VALUE_DEFINITIONS,
  deliveryOutcomeOf,
  type DeliveryValue,
} from "@/lib/observatory/delivery-values";
import { csvCell } from "@/lib/util/csv-write";

export const DELIVERY_CSV_MAX_ROWS = 50_000;

export const DELIVERY_CSV_COLUMNS = [
  "purchase_id",
  "attempted_at",
  "latency_ms",
  "observed_at",
  "resource_key",
  "network",
  "delivery",
  "delivery_reason",
  "http_status_paid",
  "payload_non_empty",
  "held_reason",
  "tx_hash",
  "buyer",
  "payer",
] as const;

export type DeliveryCsvColumn = (typeof DELIVERY_CSV_COLUMNS)[number];

/** CSV はコメント行を持てないので、列の意味をレスポンスヘッダで運ぶ（ASCII のみ）。 */
export const DELIVERY_CSV_COLUMN_NOTES =
  `${DELIVERY_VALUE_DEFINITIONS.delivered} ${DELIVERY_VALUE_DEFINITIONS.no_body_observed} ${DELIVERY_VALUE_DEFINITIONS.not_established} ` +
  "observed_at is the stored attempt time plus latency_ms, rounded up to the millisecond. latency_ms runs from the start of the purchase to the end of reading the paid response, or to the point where vet402 stopped reading a body over its size cap. The attempt time is stored partway through, so observed_at normally falls after that end. observed_at is blank when latency_ms is blank. attempted_at in this file is cut to the second. " +
  "buyer is always vet402, the reporting buyer. payer is the wallet address vet402 paid from on that row. " +
  "payload_non_empty is true, false, or blank when no record. " +
  "Full column list: https://vet402.com/openapi.yaml";

export type ObservatoryExportDaysResult =
  | { kind: "ok"; days: number }
  | { kind: "invalid_days" }
  | { kind: "redirect"; days: number };

/** 既定の observatory export.csv と同じ days 規則（無指定 90、1..366、10 進整数だけ）。 */
export function resolveObservatoryExportDays(daysParam: string | null): ObservatoryExportDaysResult {
  if (daysParam !== null && !/^[0-9]{1,9}$/.test(daysParam)) {
    return { kind: "invalid_days" };
  }
  const days = daysParam === null ? 90 : Math.min(Math.max(Number(daysParam), 1), 366);
  if (daysParam !== null && daysParam !== String(days)) {
    return { kind: "redirect", days };
  }
  return { kind: "ok", days };
}

export type DeliveryExportDbRow = {
  purchase_id: string;
  attempted_at: string;
  latency_ms: number | null;
  /** attempted_at（マイクロ秒の精度）＋ latency_ms をミリ秒に切り上げた時刻（SQL で作る）。latency_ms が無ければ null。 */
  observed_at: string | null;
  resource_key: string;
  network: string;
  status: string;
  http_status_paid: number | null;
  payload_non_empty: boolean | null;
  held_reason: string | null;
  tx_hash: string | null;
  payer: string | null;
};


function payloadNonEmptyCell(v: boolean | null): string {
  if (v === true) return "true";
  if (v === false) return "false";
  return "";
}

/** DB の 1 行を CSV の列順の値（エスケープ前）に直す。 */
export function deliveryCsvValuesFromRow(row: DeliveryExportDbRow): Record<DeliveryCsvColumn, string | number | null> {
  const outcome = deliveryOutcomeOf({
    status: row.status,
    httpStatusPaid: row.http_status_paid,
    payloadNonEmpty: row.payload_non_empty,
  });
  const delivery: DeliveryValue | "" = outcome?.delivery ?? "";
  const deliveryReason = outcome?.reason ?? "";
  return {
    purchase_id: row.purchase_id,
    attempted_at: row.attempted_at,
    latency_ms: row.latency_ms ?? "",
    observed_at: row.observed_at ?? "",
    resource_key: row.resource_key,
    network: row.network,
    delivery,
    delivery_reason: deliveryReason,
    http_status_paid: row.http_status_paid ?? "",
    payload_non_empty: payloadNonEmptyCell(row.payload_non_empty),
    held_reason: row.held_reason ?? "",
    tx_hash: row.tx_hash ?? "",
    buyer: "vet402",
    payer: row.payer ?? "",
  };
}

export function deliveryCsvLineFromRow(row: DeliveryExportDbRow): string {
  const values = deliveryCsvValuesFromRow(row);
  return DELIVERY_CSV_COLUMNS.map((c) => csvCell(values[c])).join(",");
}

const rowsOf = <T>(raw: unknown) =>
  (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

export async function loadDeliveryExportRows(
  db: AppDb,
  days: number,
): Promise<{ rows: DeliveryExportDbRow[]; truncated: boolean }> {
  const raw = await db.execute(sql`
    SELECT pu.id::text AS purchase_id,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
           pu.latency_ms,
           -- 2026-11-15: attempted_at を秒に切ってから足すと上限より早い時刻になる。元の精度で足し、ミリ秒に切り上げる。
           CASE WHEN pu.latency_ms IS NULL THEN NULL ELSE
             to_char(
               (date_trunc('milliseconds', pu.attempted_at + pu.latency_ms * interval '1 millisecond' + interval '999 microseconds'))
                 AT TIME ZONE 'utc',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           END AS observed_at,
           e.resource_key,
           pu.network,
           pu.status,
           pu.http_status_paid,
           pu.payload_non_empty,
           (${sql.raw(heldReasonSql("pu"))}) AS held_reason,
           pu.tx_hash,
           pu.payer
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.status = 'settled'
      AND pu.attempted_at >= now() - make_interval(days => ${days}::int)
    ORDER BY pu.attempted_at ASC, pu.id ASC
    LIMIT ${DELIVERY_CSV_MAX_ROWS + 1}
  `);
  const rows = rowsOf<DeliveryExportDbRow>(raw);
  const truncated = rows.length > DELIVERY_CSV_MAX_ROWS;
  return { rows: truncated ? rows.slice(0, DELIVERY_CSV_MAX_ROWS) : rows, truncated };
}

export function buildDeliveryCsvBody(rows: DeliveryExportDbRow[]): string {
  const lines = [DELIVERY_CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(deliveryCsvLineFromRow(r));
  return lines.join("\n") + "\n";
}