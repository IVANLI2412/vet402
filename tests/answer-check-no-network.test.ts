// Run: npx tsx --test tests/answer-check-no-network.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["fetch(", "x402-payer", "safe-fetch", "l1-runner", "@/lib/db"] as const;
const answerDir = join(process.cwd(), "src/lib/observatory/answer-check");
const l2Path = join(process.cwd(), "src/lib/observatory/l2-check.ts");
const L2_BINARY_MARKER = "// バイナリ出力の宣言と本文（2026-11-15 J1）";

function scanFile(path: string) {
  const text = readFileSync(path, "utf8");
  for (const token of FORBIDDEN) {
    assert.equal(text.includes(token), false, `${path} に禁止トークン ${token}`);
  }
}

const WIRED_ONLY = new Set(["cron.ts", "state-aggregate.ts"]);

test("answer-check と l2-check に禁止 import と fetch が無い", () => {
  for (const name of readdirSync(answerDir)) {
    if (name.endsWith(".ts") && !WIRED_ONLY.has(name)) scanFile(join(answerDir, name));
  }
  const l2 = readFileSync(l2Path, "utf8");
  const idx = l2.indexOf(L2_BINARY_MARKER);
  assert.ok(idx >= 0, "l2-check の J1 追記ブロックが見つからない");
  const tail = l2.slice(idx);
  for (const token of FORBIDDEN) {
    assert.equal(tail.includes(token), false, `l2-check J1 ブロックに禁止トークン ${token}`);
  }
});