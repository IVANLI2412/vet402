// Run: npx tsx --test tests/answer-check-share.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedPurchaseShare } from "@/lib/observatory/answer-check";

const now = new Date("2026-11-15T12:00:00.000Z");
const inWindow = "2026-11-10T00:00:00.000Z";

test("match 2195 + mismatch 40 + その他 settled 3426 で share は比・sharePercent 39%", () => {
  const rows: Parameters<typeof checkedPurchaseShare>[0] = [];
  for (let i = 0; i < 2195; i++) rows.push({ status: "settled", attemptedAt: inWindow, l2Reading: "match" });
  for (let i = 0; i < 40; i++) rows.push({ status: "settled", attemptedAt: inWindow, l2Reading: "mismatch" });
  for (let i = 0; i < 3426; i++) rows.push({ status: "settled", attemptedAt: inWindow, l2Reading: "no_declaration" });
  rows.push({ status: "settled", attemptedAt: "2026-10-01T00:00:00.000Z", l2Reading: "match" });
  rows.push({ status: "pending", attemptedAt: inWindow, l2Reading: "match" });
  const s = checkedPurchaseShare(rows, { now });
  assert.equal(s.settled, 5661);
  assert.equal(s.l2Checked, 2235);
  assert.ok(Math.abs(s.share! - 2235 / 5661) < 1e-9);
  assert.equal(s.sharePercent, 39);
});

test("attemptedAt は Date.parse で窓判定（桁違い・+00:00）", () => {
  const rows = [
    { status: "settled", attemptedAt: "2026-11-14T00:02:31Z", l2Reading: "match" },
    { status: "settled", attemptedAt: "2026-11-14T00:02:31.000Z", l2Reading: "match" },
    { status: "settled", attemptedAt: "2026-11-14T00:02:31+00:00", l2Reading: "match" },
    { status: "settled", attemptedAt: "not-a-date", l2Reading: "match" },
  ];
  const s = checkedPurchaseShare(rows, { now: new Date("2026-11-15T12:00:00Z"), days: 30 });
  assert.equal(s.l2Match, 3);
  assert.equal(s.settled, 3);
});

test("json_valid の pass だけの no_declaration 行は answerChecked に数えない", () => {
  const rows = [
    { status: "settled", attemptedAt: inWindow, l2Reading: "no_declaration", answerVerdicts: [{ check: "json_valid" as const, result: "pass" as const, reason: "valid_json" }] },
    { status: "settled", attemptedAt: inWindow, l2Reading: "no_declaration" },
  ];
  const s = checkedPurchaseShare(rows, { now });
  assert.equal(s.answerChecked, 0);
  assert.equal(s.shareWithAnswerChecks, 0);
  assert.equal(s.sharePercentWithAnswerChecks, 0);
});

test("binary_kind の pass は answerChecked に数える", () => {
  const rows = [
    {
      status: "settled",
      attemptedAt: inWindow,
      l2Reading: "no_declaration",
      answerVerdicts: [{ check: "binary_kind" as const, result: "pass" as const, reason: "match" }],
    },
    { status: "settled", attemptedAt: inWindow, l2Reading: "no_declaration" },
  ];
  const s = checkedPurchaseShare(rows, { now });
  assert.equal(s.answerChecked, 1);
  assert.equal(s.sharePercentWithAnswerChecks, 50);
});

test("分母 0 で share は null", () => {
  const s = checkedPurchaseShare([], { now });
  assert.equal(s.share, null);
  assert.equal(s.shareWithAnswerChecks, null);
});

test("shape_drift pass/fail は answerChecked に数える", () => {
  const jpeg = new TextDecoder().decode(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])).replaceAll("\u0000", "");
  const rows = [
    {
      status: "settled",
      attemptedAt: inWindow,
      l2Reading: "no_declaration",
      answerVerdicts: [
        { check: "binary_kind" as const, result: "not_checked" as const, reason: "binary_kind_inexact" },
        { check: "shape_drift" as const, result: "fail" as const, reason: "shape_changed" },
      ],
    },
    {
      status: "settled",
      attemptedAt: inWindow,
      l2Reading: "no_declaration",
      answerVerdicts: [{ check: "shape_drift" as const, result: "pass" as const, reason: "same_shape" }],
    },
    {
      status: "settled",
      attemptedAt: inWindow,
      l2Reading: "no_declaration",
      answerVerdicts: [{ check: "binary_kind" as const, result: "pass" as const, reason: "match" }],
    },
  ];
  assert.equal(jpeg.length > 0, true);
  const s = checkedPurchaseShare(rows, { now });
  assert.equal(s.answerChecked, 3);
});