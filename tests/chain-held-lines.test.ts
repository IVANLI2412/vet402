import { test } from "node:test";
import assert from "node:assert/strict";
import { chainHeldLines } from "@/lib/observatory/chain-page-words";

test("Tempo-style held copy avoids 202 misread and names 4xx range", () => {
  const lines = chainHeldLines({ settled: 373, delivered: 120, inconclusiveSettled: 202 });
  const text = lines.join(" ");
  assert.match(text, /400 to 499/);
  assert.match(text, /The other 51 settled purchases/);
  assert.doesNotMatch(text, /\b202 settled\b/);
  assert.doesNotMatch(text, /\b202 purchases\b/);
  assert.match(text, /a 202 Accepted/);
});

test("chainHeldLines empty when inconclusiveSettled is 0", () => {
  assert.deepEqual(chainHeldLines({ settled: 10, delivered: 8, inconclusiveSettled: 0 }), []);
});

test("chainHeldLines omits other line when remainder is 0", () => {
  const lines = chainHeldLines({ settled: 10, delivered: 7, inconclusiveSettled: 3 });
  const text = lines.join(" ");
  assert.match(text, /400 to 499/);
  assert.doesNotMatch(text, /The other/);
});