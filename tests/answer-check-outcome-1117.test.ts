// 2026-11-17 第三者点検: L2 の読みが無い行で型の確かめだけが通っても、公開の match には数えない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseAnswerCheckOutcome } from "@/lib/observatory/answer-check/outcome";

test("checks passing without an L2 reading count as checked but unknown, not match", () => {
  const r = purchaseAnswerCheckOutcome("no_declaration", [{ check: "declared_type", result: "pass", reason: "ok" }]);
  assert.equal(r.checked, true);
  assert.equal(r.outcome, "unknown");
});

test("an L2 match is still a match", () => {
  assert.equal(purchaseAnswerCheckOutcome("match", []).outcome, "match");
});
