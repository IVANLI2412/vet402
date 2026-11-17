import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("check_resource_decision passes refunds through on measurement", () => {
  const indexSrc = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(indexSrc, /measurement:\s*result/, "measurement must carry the full decision body");
  const clientSrc = readFileSync(join(root, "src/vouch-client.ts"), "utf8");
  assert.match(clientSrc, /refunds\?:/, "DecisionResult types refunds for pass-through");
});