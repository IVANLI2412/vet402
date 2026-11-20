import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("root README does not imply ai-sdk, langchain, or agentkit are on npm", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  for (const pkg of ["@vet402/ai-sdk", "@vet402/langchain", "@vet402/agentkit"]) {
    assert.ok(readme.includes(pkg), `${pkg} should be named`);
  }
  assert.match(readme, /not published to npm yet/i);
  assert.doesNotMatch(readme, /npm i @vet402\/(ai-sdk|langchain|agentkit)/);
});