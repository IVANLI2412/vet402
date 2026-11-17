import { getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { BODY_HEAD_CHARS } from "@/lib/observatory/l2-check";
import { qualifiesAsEndpointShapeBaseline } from "./baseline";
import { storedAnswerFromPurchaseRow } from "./purchase-row";
import { answerShapeOf } from "./shape-drift";
import type { EndpointShapeBaseline } from "./types";

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const rows = (raw as { rows?: unknown[] }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

type BaselineCandidateRow = {
  id: string;
  endpoint_id: string;
  attempted_at: string;
  status: string;
  http_status_paid: number | null;
  l2_schema: string | null;
  raw_response_meta: unknown;
  challenge_document: unknown;
  declared_schema: unknown;
  resource_url: string | null;
};

/** バッチ内の endpoint ごとに、全期間で最も古い complete 2xx JSON 行を基準形として1回の問い合わせで取る。 */
export async function fetchEndpointShapeBaselines(
  endpointIds: readonly string[],
): Promise<Map<string, EndpointShapeBaseline>> {
  const out = new Map<string, EndpointShapeBaseline>();
  if (endpointIds.length === 0) return out;
  const db = getDb();
  if (!db) return out;

  // 掲載ごとに条件を満たす古い順の5行まで返す（活発な掲載の全行は運ばない）。最古が使えなければ次を見る。
  const raw = await db.execute(sql`
    SELECT * FROM (
    SELECT row_number() OVER (PARTITION BY pu.endpoint_id ORDER BY pu.attempted_at ASC, pu.id ASC) AS rn,
           pu.id::text AS id,
           pu.endpoint_id::text AS endpoint_id,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attempted_at,
           pu.status,
           pu.http_status_paid,
           pu.l2_schema,
           pu.raw_response_meta,
           pu.challenge_402 AS challenge_document,
           e.declared_schema,
           e.resource_url
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.endpoint_id = ANY(${sql`ARRAY[${sql.join(endpointIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})
      AND pu.status = 'settled'
      AND pu.http_status_paid >= 200
      AND pu.http_status_paid <= 299
      AND pu.http_status_paid <> 202
      AND jsonb_typeof(pu.raw_response_meta) = 'object'
      AND coalesce((pu.raw_response_meta->>'bodyTruncated')::boolean, false) = false
      AND pu.raw_response_meta ? 'bodyHead'
      AND length(pu.raw_response_meta->>'bodyHead') < ${BODY_HEAD_CHARS}::int
      AND (pu.raw_response_meta->>'bodyBytes') ~ '^[0-9]+$'
      AND octet_length(convert_to(pu.raw_response_meta->>'bodyHead', 'UTF8')) = (pu.raw_response_meta->>'bodyBytes')::int
      AND left(btrim(pu.raw_response_meta->>'bodyHead'), 1) IN ('{', '[')
      AND NOT (pu.raw_response_meta ? 'bodyError')
    ) c
    WHERE c.rn <= 5
    ORDER BY c.endpoint_id, c.rn
  `);
  const rows = rowsOf(raw) as BaselineCandidateRow[];
  for (const row of rows) {
    if (out.has(row.endpoint_id)) continue;
    const answer = storedAnswerFromPurchaseRow({
      purchaseId: row.id,
      endpointKey: row.endpoint_id,
      attemptedAt: row.attempted_at,
      status: row.status,
      httpStatusPaid: row.http_status_paid,
      l2Schema: row.l2_schema,
      rawResponseMeta: row.raw_response_meta,
      challengeDocument: row.challenge_document,
      catalogDeclaredSchema: row.declared_schema,
      resourceUrl: row.resource_url,
    });
    if (!qualifiesAsEndpointShapeBaseline(answer)) continue;
    const shape = answerShapeOf(answer);
    if (shape === null) continue;
    out.set(row.endpoint_id, { purchaseId: row.id, shape });
  }
  return out;
}