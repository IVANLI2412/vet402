import type { AnswerCheckName, AnswerVerdict } from "./types";

const SELLER_FAIL_CHECKS: ReadonlySet<AnswerCheckName> = new Set(["json_valid", "declared_type", "binary_kind"]);

const COUNT_CHECKS: readonly AnswerCheckName[] = ["declared_type", "input_echo", "binary_kind", "shape_drift"];

export type PurchaseAnswerCheckResult = {
  checked: boolean;
  outcome: "match" | "mismatch" | "unknown";
  checks: AnswerCheckName[];
  reason?: string;
};

function countsAsChecked(l2Reading: string | null, verdicts: readonly AnswerVerdict[]): boolean {
  if (l2Reading === "match" || l2Reading === "mismatch") return true;
  return verdicts.some((v) => COUNT_CHECKS.includes(v.check) && (v.result === "pass" || v.result === "fail"));
}

/** 1 行分の判定結果と L2 の読み直しから、答えチェックの要約を作る（純関数）。 */
export function purchaseAnswerCheckOutcome(
  l2Reading: string | null,
  verdicts: readonly AnswerVerdict[],
): PurchaseAnswerCheckResult {
  const checks = verdicts.map((v) => v.check);
  const fails = verdicts.filter((v) => v.result === "fail" && SELLER_FAIL_CHECKS.has(v.check));
  const checked = countsAsChecked(l2Reading, verdicts);

  if (l2Reading === "mismatch" || fails.length > 0) {
    const fail = fails[0];
    return {
      checked: true,
      outcome: "mismatch",
      checks,
      reason: fail ? `${fail.check}:${fail.reason}` : "l2_mismatch",
    };
  }
  if (l2Reading === "match") {
    return { checked: true, outcome: "match", checks, reason: "l2_match" };
  }
  const shapeDriftFail = verdicts.find((v) => v.check === "shape_drift" && v.result === "fail");
  if (checked && shapeDriftFail) {
    return { checked: true, outcome: "unknown", checks, reason: "shape_changed" };
  }
  const passes = verdicts.filter((v) => v.result === "pass");
  if (checked && passes.length > 0) {
    // 2026-11-17 第三者点検: L2 が match/mismatch を出せない行で、型などの確かめだけが通っても「一致」とは数えない
    // （公開の match は L2 の読みが一致したものだけ）。確かめた行としては数える。
    return { checked: true, outcome: "unknown", checks, reason: "checks_pass_no_l2_reading" };
  }
  if (!checked) {
    return { checked: false, outcome: "unknown", checks, reason: "nothing_to_check" };
  }
  return { checked: true, outcome: "unknown", checks, reason: "insufficient_evidence" };
}