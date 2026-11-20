import { apiDocsPageText } from "./lib/api-docs-source";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("export docs say auth_nonce is internal and SDK nonce is not stored", () => {
  const api = apiDocsPageText();
  const openapi = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
  assert.match(api, /auth_nonce is recorded on vet402's own signed purchase rows/);
  assert.match(api, /sdk's payment nonce is not ingested or stored/i);
  assert.match(openapi, /not stored or replayed/);
});