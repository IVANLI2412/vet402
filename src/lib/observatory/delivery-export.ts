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
import { L1_PAID_BODY_CAP_BYTES } from "@/lib/observatory/l2-check";

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
  "body_bytes",
  "payload_non_empty",
  "held_reason",
  "tx_hash",
  "buyer",
  "payer",
] as const;

export type DeliveryCsvColumn = (typeof DELIVERY_CSV_COLUMNS)[number];

/** body_bytes の意味（公開文・列の説明ヘッダ・methodology・/docs/api がこの 1 か所を読む）。 */
export const DELIVERY_CSV_BODY_BYTES_NOTE =
  `body_bytes is the size in bytes of the paid response body vet402 read, 0 for an empty body, blank when the row has no record of it (rows before 2026-09-29 and lanes that do not store it). A body over the ${L1_PAID_BODY_CAP_BYTES}-byte read cap shows ${L1_PAID_BODY_CAP_BYTES}, the read cap, not the full size. payload_non_empty is false when the body is empty or only whitespace, or when reading it stopped partway (a timeout or a dropped connection), and body_bytes then counts the bytes received before it stopped.`;

/** CSV はコメント行を持てないので、列の意味をレスポンスヘッダで運ぶ（ASCII のみ）。 */
export const DELIVERY_CSV_COLUMN_NOTES =
  `${DELIVERY_VALUE_DEFINITIONS.delivered} ${DELIVERY_VALUE_DEFINITIONS.no_body_observed} ${DELIVERY_VALUE_DEFINITIONS.not_established} ` +
  "observed_at is the stored attempt time plus latency_ms, rounded up to the millisecond. latency_ms runs from the start of the purchase to the end of reading the paid response, or to the point where vet402 stopped reading a body over its size cap. The attempt time is stored partway through, so observed_at normally falls after that end. observed_at is blank when latency_ms is blank. attempted_at in this file is cut to the second. " +
  "buyer is always vet402, the reporting buyer. payer is the wallet address vet402 paid from on that row. " +
  "payload_non_empty is true, false, or blank when no record (see body_bytes below for what counts as false). " +
  `${DELIVERY_CSV_BODY_BYTES_NOTE} ` +
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
  /** raw_response_meta.bodyBytes（l1-runner が 2026-09-29 から記録・上限で頭打ち）。記録が無ければ null。 */
  body_bytes: number | string | null;
  payload_non_empty: boolean | null;
  held_reason: string | null;
  tx_hash: string | null;
  payer: string | null;
};


/** 0 以上の整数だけを出す。記録が無い・形が違う値は空欄（0 に倒さない）。 */
export function bodyBytesCell(v: number | string | null | undefined): number | "" {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : /^[0-9]{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : "";
}

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
    body_bytes: bodyBytesCell(row.body_bytes),
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
           -- 2026-11-16: 支払った応答の本文のバイト数（l1-runner の raw_response_meta.bodyBytes）。数でない値は NULL。
           CASE WHEN jsonb_typeof(pu.raw_response_meta->'bodyBytes') = 'number'
                THEN pu.raw_response_meta->>'bodyBytes' END AS body_bytes,
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

/** 誰の購入か（公開文・methodology と /docs/api がこの 1 か所を読む）。 */
export const DELIVERY_CSV_WHOSE_PURCHASES =
  "Every row is a purchase vet402 made with its own wallets, so the rates describe vet402's own purchases, not every buyer of the seller.";

/** 応答ヘッダの意味（公開文・1 行ずつ。methodology と /docs/api がこの 1 か所を読む）。 */
export const DELIVERY_CSV_HEADER_NOTES = {
  "x-vet402-buyer": "x-vet402-buyer is vet402 on every response, the buyer behind every row. The CSV body carries no comment line.",
  "x-vet402-as-of": "x-vet402-as-of is the latest attempted_at among the rows in the file, in UTC to the second. It is blank when the file has no rows.",
  "x-vet402-generated-at": "x-vet402-generated-at is when the server built the file, in UTC. A cached copy keeps the time it was built.",
} as const;

/** 応答ヘッダ x-vet402-buyer の値。全行が vet402 自身の財布での購入（外の買い手の受領書はこのファイルに入れない）。 */
export const DELIVERY_CSV_BUYER = "vet402";

/**
 * 応答ヘッダ x-vet402-as-of: そのファイルに入った行の attempted_at の最大（列と同じ UTC の ISO・秒）。
 * 行が無ければ空文字。attempted_at は固定幅の ISO なので文字列の大小で比べられる。
 */
export function deliveryCsvAsOf(rows: readonly Pick<DeliveryExportDbRow, "attempted_at">[]): string {
  let max = "";
  for (const r of rows) if (typeof r.attempted_at === "string" && r.attempted_at > max) max = r.attempted_at;
  return max;
}

export function buildDeliveryCsvBody(rows: DeliveryExportDbRow[]): string {
  const lines = [DELIVERY_CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(deliveryCsvLineFromRow(r));
  return lines.join("\n") + "\n";
}