import { getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { isMissingSchemaError } from "@/lib/db/pg-errors";

/** 公開 state.l1.answerCheck の 30 日窓（日数は state と cron で共有）。 */
export const ANSWER_CHECK_WINDOW_DAYS = 30;

export type L1AnswerCheckStats = {
  windowDays: number;
  settled: number;
  checked: number;
  match: number;
  mismatch: number;
  unknown: number;
  /** 未宣言行で最初の答えと形が同じ（shape_drift pass）。公開 match には含めない。 */
  shapeSame: number;
  /** 未宣言行で最初の答えから形が変わった（shape_drift fail・outcome は unknown）。 */
  shapeChanged: number;
  checkedShare: number | null;
};

export function emptyL1AnswerCheckStats(windowDays = ANSWER_CHECK_WINDOW_DAYS): L1AnswerCheckStats {
  return {
    windowDays,
    settled: 0,
    checked: 0,
    match: 0,
    mismatch: 0,
    unknown: 0,
    shapeSame: 0,
    shapeChanged: 0,
    checkedShare: null,
  };
}

export function l1AnswerCheckFromRowCounts(input: {
  settled: number;
  checked: number;
  match: number;
  mismatch: number;
  unknown: number;
  shapeSame?: number;
  shapeChanged?: number;
  windowDays?: number;
}): L1AnswerCheckStats {
  const windowDays = input.windowDays ?? ANSWER_CHECK_WINDOW_DAYS;
  const settled = input.settled;
  const checkedShare = settled === 0 ? null : input.checked / settled;
  return {
    windowDays,
    settled,
    checked: input.checked,
    match: input.match,
    mismatch: input.mismatch,
    unknown: input.unknown,
    shapeSame: input.shapeSame ?? 0,
    shapeChanged: input.shapeChanged ?? 0,
    checkedShare,
  };
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const rows = (raw as { rows?: unknown[] }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** 台帳に書いた answerCheck から 30 日 settled の集計を読む（安い 1 クエリ）。 */
export async function readL1AnswerCheckStats(windowDays = ANSWER_CHECK_WINDOW_DAYS): Promise<L1AnswerCheckStats> {
  const db = getDb();
  if (!db) return emptyL1AnswerCheckStats(windowDays);
  try {
    const raw = await db.execute(sql`
      SELECT count(*)::int AS settled,
             count(*) FILTER (WHERE (raw_response_meta->'answerCheck'->>'checked') = 'true')::int AS checked,
             count(*) FILTER (WHERE raw_response_meta->'answerCheck'->>'outcome' = 'match')::int AS match,
             count(*) FILTER (WHERE raw_response_meta->'answerCheck'->>'outcome' = 'mismatch')::int AS mismatch,
             count(*) FILTER (WHERE raw_response_meta->'answerCheck'->>'outcome' = 'unknown' AND (raw_response_meta->'answerCheck'->>'checked') = 'true')::int AS unknown,
             count(*) FILTER (WHERE raw_response_meta->'answerCheck'->>'shapeBaseline' = 'same')::int AS shape_same,
             count(*) FILTER (WHERE raw_response_meta->'answerCheck'->>'shapeBaseline' = 'changed')::int AS shape_changed
      FROM x402_l1_purchases
      WHERE status = 'settled'
        AND attempted_at >= now() - make_interval(days => ${windowDays}::int)
    `);
    const row = rowsOf(raw)[0] ?? {};
    return l1AnswerCheckFromRowCounts({
      settled: Number(row.settled ?? 0),
      checked: Number(row.checked ?? 0),
      match: Number(row.match ?? 0),
      mismatch: Number(row.mismatch ?? 0),
      unknown: Number(row.unknown ?? 0),
      shapeSame: Number(row.shape_same ?? 0),
      shapeChanged: Number(row.shape_changed ?? 0),
      windowDays,
    });
  } catch (error) {
    if (isMissingSchemaError(error)) return emptyL1AnswerCheckStats(windowDays);
    throw error;
  }
}