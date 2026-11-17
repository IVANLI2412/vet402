// 2026-11-18: feedbackURI はチェーンに誰でも書けるので、サーバーが内部の宛先へ要求を出さない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpsUrl } from "@/lib/erc8004-check/feedback-uri";

test("public https URLs pass", () => {
  assert.doesNotThrow(() => assertPublicHttpsUrl("https://vet402.com/api/v1/observatory/erc8004/weekly/1?week=2026-W46"));
});

for (const bad of [
  "http://example.com/x",
  "https://169.254.169.254/latest/meta-data",
  "https://127.0.0.1/x",
  "https://[::1]/x",
  "https://localhost/x",
  "https://metadata.google.internal/x",
  "https://example.com:8080/x",
  "https://user:pw@example.com/x",
  "file:///etc/passwd",
]) {
  test(`refused: ${bad}`, () => {
    assert.throws(() => assertPublicHttpsUrl(bad));
  });
}

import { readFeedbackUri, FEEDBACK_URI_MAX_BYTES } from "@/lib/erc8004-check/feedback-uri";

test("a huge data: URI is refused before decoding", async () => {
  const big = "data:application/json;base64," + "A".repeat(Math.ceil((FEEDBACK_URI_MAX_BYTES * 4) / 3) + 100);
  await assert.rejects(() => readFeedbackUri(big));
});

test("a huge percent-encoded data: URI is refused", async () => {
  const big = "data:text/plain," + "%41".repeat(FEEDBACK_URI_MAX_BYTES + 10);
  await assert.rejects(() => readFeedbackUri(big));
});
