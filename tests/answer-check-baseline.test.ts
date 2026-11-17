// Run: npx tsx --test tests/answer-check-baseline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_HEAD_CHARS } from "@/lib/observatory/l2-check";
import {
  judgeShapeDriftWithExternalBaseline,
  purchaseAnswerCheckOutcome,
  qualifiesAsEndpointShapeBaseline,
} from "@/lib/observatory/answer-check";
import type { AnswerShape } from "@/lib/observatory/answer-check/shape-drift";
import type { EndpointShapeBaseline, StoredAnswer } from "@/lib/observatory/answer-check";

function base(overrides: Partial<StoredAnswer> = {}): StoredAnswer {
  return {
    purchaseId: "p1",
    endpointKey: "ep1",
    attemptedAt: "2026-11-02T00:00:00Z",
    status: "settled",
    httpStatus: 200,
    contentType: "application/json",
    bodyHead: '{"a":1}',
    bodyBytes: 7,
    resourceUrl: "https://example.com/x",
    challengeDocument: {},
    requestQuery: null,
    requestQuerySha256: null,
    requestBody: null,
    requestBodySha256: null,
    catalogDeclaredSchema: null,
    l2Reading: "no_declaration",
    bodyIncomplete: null,
    ...overrides,
  };
}

const baselineShape: AnswerShape = { kind: "json_object", keys: { a: "number" } };
const endpointBaseline: EndpointShapeBaseline = { purchaseId: "base-p", shape: baselineShape };

test("compare: 同一・余分キーは pass、キー消失・型変化・kind 変化は fail", () => {
  assert.equal(judgeShapeDriftWithExternalBaseline(base({ bodyHead: '{"a":1}', bodyBytes: 7 }), endpointBaseline).result, "pass");
  assert.equal(
    judgeShapeDriftWithExternalBaseline(base({ bodyHead: '{"a":1,"b":2}', bodyBytes: 13 }), endpointBaseline).result,
    "pass",
  );
  const missingKey = '{"b":2}';
  assert.equal(
    judgeShapeDriftWithExternalBaseline(
      base({ bodyHead: missingKey, bodyBytes: Buffer.byteLength(missingKey) }),
      endpointBaseline,
    ).result,
    "fail",
  );
  const typeChange = '{"a":"x"}';
  assert.equal(
    judgeShapeDriftWithExternalBaseline(
      base({ bodyHead: typeChange, bodyBytes: Buffer.byteLength(typeChange) }),
      endpointBaseline,
    ).result,
    "fail",
  );
  const kindChange = '["a"]';
  assert.equal(
    judgeShapeDriftWithExternalBaseline(
      base({ bodyHead: kindChange, bodyBytes: Buffer.byteLength(kindChange) }),
      endpointBaseline,
    ).result,
    "fail",
  );
});

test("truncated body は not_checked（基準にもならない）", () => {
  const truncated = base({
    bodyHead: "{".repeat(BODY_HEAD_CHARS),
    bodyBytes: BODY_HEAD_CHARS + 10,
    bodyIncomplete: true,
  });
  assert.equal(qualifiesAsEndpointShapeBaseline(truncated), false);
  assert.equal(judgeShapeDriftWithExternalBaseline(truncated, endpointBaseline).result, "not_checked");
  assert.equal(judgeShapeDriftWithExternalBaseline(truncated, endpointBaseline).reason, "no_full_body");
});

test("自分自身は baseline 比較の対象にしない", () => {
  const selfBaseline: EndpointShapeBaseline = { purchaseId: "p1", shape: baselineShape };
  assert.equal(judgeShapeDriftWithExternalBaseline(base(), selfBaseline).reason, "baseline");
});

test("shape_drift fail は outcome unknown shape_changed、pass は checked", () => {
  const missingKey = '{"b":2}';
  const failVerdicts = [
    judgeShapeDriftWithExternalBaseline(
      base({ bodyHead: missingKey, bodyBytes: Buffer.byteLength(missingKey) }),
      endpointBaseline,
    ),
  ];
  const fail = purchaseAnswerCheckOutcome("no_declaration", failVerdicts);
  assert.equal(fail.checked, true);
  assert.equal(fail.outcome, "unknown");
  assert.equal(fail.reason, "shape_changed");

  const passVerdicts = [judgeShapeDriftWithExternalBaseline(base(), endpointBaseline)];
  const pass = purchaseAnswerCheckOutcome("no_declaration", passVerdicts);
  assert.equal(pass.checked, true);
  assert.equal(pass.outcome, "unknown");
  assert.equal(pass.reason, "checks_pass_no_l2_reading");
});