import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("moderate depth requires payments on at least two UTC days", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/scoring/payee-engine.ts"), "utf8");
  assert.match(src, /paymentCount >= 3 && independentPayers >= 2 && stats\.uniqueDays >= 2/);
});