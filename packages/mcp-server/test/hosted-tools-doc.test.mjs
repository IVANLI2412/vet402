// Hosted MCP tools at vet402.com/mcp — README の一覧が実装の TOOL_NAMES と揃う。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

test("README Hosted endpoint lists every hosted read-only tool name", () => {
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  const hosted = [
    "check_x402_seller",
    "check_my_x402_endpoint",
    "find_x402_sellers",
    "check_payment_proof",
    "check_8004_agent",
  ];
  for (const name of hosted) {
    assert.ok(readme.includes(`\`${name}\``), `README missing hosted tool ${name}`);
  }
});