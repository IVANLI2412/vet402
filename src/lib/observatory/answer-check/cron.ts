import { getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { checkStoredPurchaseAnswer } from "./run-one";
import type { PurchaseAnswerCheckResult } from "./outcome";
import type { AnswerVerdict } from "./types";
import { ANSWER_CHECK_WINDOW_DAYS } from "./state-aggregate";

const DEFAULT_BATCH = 250;
const DEFAULT_BUDGET_MS = 45_000;

export type AnswerCheckCronResult = {
  processed: number;
  written: number;
  skipped: number;
  budgetExceeded: boolean;
};

type PurchaseRow = {
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

function rowsOf(raw: unknown): PurchaseRow[] {
  if (Array.isArray(raw)) return raw as PurchaseRow[];
  const rows = (raw as { rows?: unknown[] }).rows;
  return Array.isArray(rows) ? (rows as PurchaseRow[]) : [];
}

export function answerCheckPayloadOf(result: PurchaseAnswerCheckResult, verdicts: AnswerVerdict[]): Record<string, unknown> {
  return {
    checkedAt: new Date().toISOString(),
    checked: result.checked,
    outcome: result.outcome,
    reason: result.reason ?? null,
    checks: result.checks,
    verdicts,
  };
}

/** settled 行の raw_response_meta.answerCheck を書く（他キーは jsonb merge で残す）。 */
export async function writeAnswerCheckMeta(
  db: NonNullable<ReturnType<typeof getDb>>,
  purchaseId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  // raw_response_meta がオブジェクトでない行（配列・文字列）には書かない（|| が配列の連結になり中身を壊すため）。
  const raw = await db.execute(sql`
    UPDATE x402_l1_purchases
    SET raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object('answerCheck', ${JSON.stringify(payload)}::jsonb)
    WHERE id = ${purchaseId}::uuid
      AND (raw_response_meta IS NULL OR jsonb_typeof(raw_response_meta) = 'object')
      AND (raw_response_meta->'answerCheck' IS NULL OR raw_response_meta->'answerCheck' = 'null'::jsonb)
    RETURNING id
  `);
  return rowsOf(raw).length > 0;
}

export async function runAnswerCheckCron(opts?: {
  batchSize?: number;
  budgetMs?: number;
  windowDays?: number;
  now?: Date;
}): Promise<AnswerCheckCronResult> {
  const db = getDb();
  if (!db) return { processed: 0, written: 0, skipped: 0, budgetExceeded: false };

  const batchSize = opts?.batchSize ?? DEFAULT_BATCH;
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const windowDays = opts?.windowDays ?? ANSWER_CHECK_WINDOW_DAYS;
  const started = Date.now();

  const raw = await db.execute(sql`
    SELECT pu.id::text AS id,
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
    WHERE pu.status = 'settled'
      AND pu.attempted_at >= now() - make_interval(days => ${windowDays}::int)
      AND jsonb_typeof(pu.raw_response_meta) = 'object'
      AND (pu.raw_response_meta->'answerCheck' IS NULL OR pu.raw_response_meta->'answerCheck' = 'null'::jsonb)
    ORDER BY pu.attempted_at ASC
    LIMIT ${batchSize}::int
  `);
  const rows = rowsOf(raw);
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let budgetExceeded = false;

  for (const row of rows) {
    if (Date.now() - started > budgetMs) {
      budgetExceeded = true;
      break;
    }
    processed++;
    try {
      const checked = checkStoredPurchaseAnswer({
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
      const payload = answerCheckPayloadOf(checked, checked.verdicts);
      if (await writeAnswerCheckMeta(db, row.id, payload)) written++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  return { processed, written, skipped, budgetExceeded };
}