// ============================================================
// 保存済みの購入応答に対する答えの試験（J1・内部）。
//
// 何を: 台帳に残った bodyHead 等だけを材料に、JSON の妥当性・宣言型・形の漂流・
// 入力のエコー・バイナリ種別を判定する。
// なぜ: Lumière は項目の有無まで見る。vet402 は払った応答の中身を見る。追加の購入はしない
// （計画の改訂 20:20b）。
// 何をしない: 新しい HTTP 要求・DB 参照・支払いはしない。
//
// 設計だけ（実装しない）:
// - 相場の参照値照合: 無料の公開出所が要り、判定のたびに外へ問い合わせる＝この本では
//   新しいリクエストを足さない。案: 日次の別作業が鎖上の値か無料 API を1回取り、購入時刻と比べる。
// - QR の復号: 台帳には先頭 500 文字しか残らず画像を復元できない。案: 全文を持つ購入時だけ復号し結果を記録。
// ============================================================

export type { AnswerCheckName, AnswerVerdict, EndpointShapeBaseline, StoredAnswer } from "./types";
export { completeBodyOf } from "./body";
export { checkJsonValid } from "./json-valid";
export { checkDeclaredType } from "./declared-type";
export { answerShapeOf, checkShapeDrift, judgeShapeDriftWithExternalBaseline } from "./shape-drift";
export { qualifiesAsEndpointShapeBaseline } from "./baseline";
export { fetchEndpointShapeBaselines } from "./baseline-fetch";
export { checkInputEcho } from "./input-echo";
export { checkBinaryKind } from "./binary-kind";
export { checkedPurchaseShare } from "./checked-share";
export { purchaseAnswerCheckOutcome, type PurchaseAnswerCheckResult } from "./outcome";
export { storedAnswerFromPurchaseRow } from "./purchase-row";
export { checkStoredPurchaseAnswer, type StoredPurchaseAnswerCheck } from "./run-one";
export {
  ANSWER_CHECK_WINDOW_DAYS,
  emptyL1AnswerCheckStats,
  l1AnswerCheckFromRowCounts,
  readL1AnswerCheckStats,
  type L1AnswerCheckStats,
} from "./state-aggregate";
export {
  ANSWER_CHECK_PAYLOAD_VERSION,
  answerCheckPayloadOf,
  runAnswerCheckCron,
  upgradeAnswerCheckMeta,
  writeAnswerCheckMeta,
  type AnswerCheckCronResult,
} from "./cron";

import { checkBinaryKind } from "./binary-kind";
import { checkDeclaredType } from "./declared-type";
import { checkInputEcho } from "./input-echo";
import { checkJsonValid } from "./json-valid";
import type { EndpointShapeBaseline } from "./types";
import { checkShapeDrift, judgeShapeDriftWithExternalBaseline } from "./shape-drift";
import type { AnswerCheckName, AnswerVerdict, StoredAnswer } from "./types";

const JUDGES: { fn: (a: StoredAnswer) => AnswerVerdict; check: AnswerCheckName }[] = [
  { fn: checkJsonValid, check: "json_valid" },
  { fn: checkDeclaredType, check: "declared_type" },
  { fn: checkInputEcho, check: "input_echo" },
  { fn: checkBinaryKind, check: "binary_kind" },
];

export function runAnswerChecks(
  answers: StoredAnswer[],
  opts?: { endpointBaselines?: Map<string, EndpointShapeBaseline> },
): Map<string, AnswerVerdict[]> {
  let shapeMap: Map<string, AnswerVerdict>;
  try {
    if (opts?.endpointBaselines) {
      shapeMap = new Map();
      for (const a of answers) {
        shapeMap.set(a.purchaseId, judgeShapeDriftWithExternalBaseline(a, opts.endpointBaselines.get(a.endpointKey)));
      }
    } else {
      shapeMap = checkShapeDrift(answers);
    }
  } catch {
    shapeMap = new Map();
    for (const a of answers) {
      shapeMap.set(a.purchaseId, { check: "shape_drift", result: "not_checked", reason: "judge_error" });
    }
  }
  const out = new Map<string, AnswerVerdict[]>();
  for (const a of answers) {
    const verdicts: AnswerVerdict[] = [];
    for (const { fn, check } of JUDGES) {
      try {
        verdicts.push(fn(a));
      } catch {
        verdicts.push({ check, result: "not_checked", reason: "judge_error" });
      }
    }
    const drift = shapeMap.get(a.purchaseId);
    if (drift) verdicts.push(drift);
    out.set(a.purchaseId, verdicts);
  }
  return out;
}