import { purchaseAnswerCheckOutcome, type PurchaseAnswerCheckResult } from "./outcome";
import { storedAnswerFromPurchaseRow } from "./purchase-row";
import { runAnswerChecks } from "./index";
import type { AnswerVerdict } from "./types";

export type { PurchaseAnswerCheckResult } from "./outcome";

export type StoredPurchaseAnswerCheck = PurchaseAnswerCheckResult & { verdicts: AnswerVerdict[] };

/** 保存済みの購入行 1 件に答えチェックを走らせ、要約を返す（HTTP・DB 書き込み無し）。 */
export function checkStoredPurchaseAnswer(row: Parameters<typeof storedAnswerFromPurchaseRow>[0]): StoredPurchaseAnswerCheck {
  const answer = storedAnswerFromPurchaseRow(row);
  const verdictMap = runAnswerChecks([answer]);
  const verdicts = verdictMap.get(answer.purchaseId) ?? [];
  const summary = purchaseAnswerCheckOutcome(answer.l2Reading, verdicts);
  return { ...summary, verdicts };
}