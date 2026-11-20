import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("/check redirects to the home paste field (temporary)", () => {
  const src = readFileSync("next.config.ts", "utf8");
  assert.match(src, /source:\s*"\/check"[\s\S]*destination:\s*"\/#lp-paste-url"[\s\S]*permanent:\s*false/);
});