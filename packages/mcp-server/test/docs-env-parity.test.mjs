// payaudit-11 / adversary-7: README and tool description mention env policy merge and the three env knobs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(PKG, "src/index.ts");
const README = join(PKG, "README.md");

test("README documents VOUCH_SESSION_MAX_USD, VOUCH_ALLOW_WAIVE_VET402, VOUCH_MIN_L1_DELIVERIES", () => {
  const text = readFileSync(README, "utf8");
  for (const name of ["VOUCH_SESSION_MAX_USD", "VOUCH_ALLOW_WAIVE_VET402", "VOUCH_MIN_L1_DELIVERIES"]) {
    assert.match(text, new RegExp(name), `README missing ${name}`);
  }
});

test("pay_if_trusted tool text mentions onUnresolved and env-controlled waiver/floors", () => {
  const src = readFileSync(INDEX, "utf8");
  assert.match(src, /onUnresolved/, "index missing onUnresolved");
  assert.match(src, /mergePolicyFromEnv|policyFromEnv/, "index missing env policy merge");
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /onUnresolved|uncatalogued/, "README should mention onUnresolved behavior");
});
test("policy text no longer claims the input is forwarded unchanged (whitehat-R5-5)", () => {
  const src = readFileSync(INDEX, "utf8");
  const readme = readFileSync(README, "utf8");
  assert.doesNotMatch(src, /payOrRefuse unchanged/, "tool text still says unchanged");
  assert.doesNotMatch(readme, /forwarded to `payOrRefuse` unchanged/, "README still says unchanged");
  assert.doesNotMatch(readme, /env `both` \+ tool `subgraph` → `subgraph`/, "README keeps an example the env cannot produce");
});
