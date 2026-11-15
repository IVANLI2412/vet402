// 内部の集計だけ。公開は 11/19 以降。

import type { AnswerCheckName, AnswerVerdict } from "./types";

const DEFAULT_COUNT_CHECKS: readonly AnswerCheckName[] = ["declared_type", "input_echo", "binary_kind"];

function attemptedAtMs(attemptedAt: string): number | null {
  const ms = Date.parse(attemptedAt);
  return Number.isFinite(ms) ? ms : null;
}

function inTimeWindow(attemptedAt: string, windowStartMs: number, windowEndMs: number): boolean {
  const ms = attemptedAtMs(attemptedAt);
  if (ms === null) return false;
  return ms >= windowStartMs && ms <= windowEndMs;
}

export function checkedPurchaseShare(
  rows: { status: string; attemptedAt: string; l2Reading: string | null; answerVerdicts?: readonly AnswerVerdict[] }[],
  opts: { now: Date; days?: number; countChecks?: readonly AnswerCheckName[] },
): {
  windowStart: string;
  windowEnd: string;
  settled: number;
  l2Match: number;
  l2Mismatch: number;
  l2Checked: number;
  share: number | null;
  sharePercent: number | null;
  answerChecked: number;
  shareWithAnswerChecks: number | null;
  sharePercentWithAnswerChecks: number | null;
} {
  const days = opts.days ?? 30;
  const windowEndMs = opts.now.getTime();
  const windowStartMs = windowEndMs - days * 86_400_000;
  const windowEnd = opts.now.toISOString();
  const windowStart = new Date(windowStartMs).toISOString();
  const countChecks = opts.countChecks ?? DEFAULT_COUNT_CHECKS;
  const inWindow = rows.filter((r) => inTimeWindow(r.attemptedAt, windowStartMs, windowEndMs));
  const settled = inWindow.filter((r) => r.status === "settled");
  const l2Match = settled.filter((r) => r.l2Reading === "match").length;
  const l2Mismatch = settled.filter((r) => r.l2Reading === "mismatch").length;
  const l2Checked = l2Match + l2Mismatch;
  const share = settled.length === 0 ? null : l2Checked / settled.length;
  const sharePercent = share === null ? null : Math.round(share * 100);
  const countsAsAnswerChecked = (r: (typeof rows)[0]) => {
    if (r.l2Reading === "match" || r.l2Reading === "mismatch") return true;
    return (r.answerVerdicts ?? []).some(
      (v) => countChecks.includes(v.check) && (v.result === "pass" || v.result === "fail"),
    );
  };
  const answerChecked = settled.filter(countsAsAnswerChecked).length;
  const shareWithAnswerChecks = settled.length === 0 ? null : answerChecked / settled.length;
  const sharePercentWithAnswerChecks =
    shareWithAnswerChecks === null ? null : Math.round(shareWithAnswerChecks * 100);
  return {
    windowStart,
    windowEnd,
    settled: settled.length,
    l2Match,
    l2Mismatch,
    l2Checked,
    share,
    sharePercent,
    answerChecked,
    shareWithAnswerChecks,
    sharePercentWithAnswerChecks,
  };
}