// Run: npx tsx --test tests/answer-check-wiring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkL2Detailed } from "@/lib/observatory/l2-check";
import {
  checkStoredPurchaseAnswer,
  purchaseAnswerCheckOutcome,
  storedAnswerFromPurchaseRow,
} from "@/lib/observatory/answer-check";

test("カタログ宣言と JSON Schema 文書の見本: 正しい応答を mismatch にしない（回帰）", () => {
  const catalog = {
    properties: {
      output: { properties: { example: { required: ["price"], properties: { price: { type: "number" } } } } },
    },
  };
  const schemaAsExample = { type: "object", properties: { price: { type: "number" } }, required: ["price"] };
  const body = '{"price":1}';
  const d = checkL2Detailed(catalog, body, "application/json", null, schemaAsExample);
  assert.equal(d.status, "match");
  assert.deepEqual(d.missing, []);
});

test("checkStoredPurchaseAnswer: l2 match は outcome match", () => {
  const r = checkStoredPurchaseAnswer({
    purchaseId: "p1",
    endpointKey: "e1",
    attemptedAt: "2026-11-10T00:00:00.000Z",
    status: "settled",
    httpStatusPaid: 200,
    l2Schema: "match",
    rawResponseMeta: {
      bodyHead: '{"a":1}',
      bodyBytes: 7,
      contentType: "application/json",
      l2: { reason: null, missing: [] },
    },
    challengeDocument: {},
    catalogDeclaredSchema: { properties: { output: { properties: { example: { required: ["a"] } } } } },
    resourceUrl: "https://example.com/x",
  });
  assert.equal(r.checked, true);
  assert.equal(r.outcome, "match");
  assert.ok(r.checks.includes("json_valid"));
});

test("purchaseAnswerCheckOutcome: fail 無しの not_checked は unknown", () => {
  const row = storedAnswerFromPurchaseRow({
    purchaseId: "p2",
    endpointKey: "e2",
    attemptedAt: "2026-11-10T00:00:00.000Z",
    status: "settled",
    httpStatusPaid: 200,
    l2Schema: "no_declaration",
    rawResponseMeta: { bodyHead: "ok", bodyBytes: 2, contentType: "text/plain" },
    challengeDocument: {},
    catalogDeclaredSchema: null,
  });
  const checked = checkStoredPurchaseAnswer({
    purchaseId: row.purchaseId,
    endpointKey: row.endpointKey,
    attemptedAt: row.attemptedAt,
    status: row.status,
    httpStatusPaid: row.httpStatus,
    l2Schema: "no_declaration",
    rawResponseMeta: { bodyHead: "ok", bodyBytes: 2, contentType: "text/plain" },
    challengeDocument: {},
    catalogDeclaredSchema: null,
  });
  assert.equal(checked.outcome, "unknown");
  assert.equal(purchaseAnswerCheckOutcome("no_declaration", checked.verdicts).outcome, "unknown");
});

test("purchaseAnswerCheckOutcome: json_valid fail は mismatch", () => {
  const checked = checkStoredPurchaseAnswer({
    purchaseId: "p3",
    endpointKey: "e3",
    attemptedAt: "2026-11-10T00:00:00.000Z",
    status: "settled",
    httpStatusPaid: 200,
    l2Schema: "no_declaration",
    rawResponseMeta: { bodyHead: "{bad", bodyBytes: 4, contentType: "application/json" },
    challengeDocument: {},
    catalogDeclaredSchema: null,
  });
  assert.equal(checked.outcome, "mismatch");
});