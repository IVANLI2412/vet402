// W4 persona audit fixes: usability (G1-006, C2-007, C3-005) and confidentiality (G3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_FIRST_PROMPTS } from "@/lib/docs/mcp-first-prompts";
import { assertPublicEnglishSurface } from "@/lib/v4/public-english";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("G1-006: MCP explain prompt matches public check (POST api.exa.ai/search is ALLOW, not BLOCK)", () => {
  const explain = MCP_FIRST_PROMPTS.find((p) => p.id === "explain_verdict");
  assert.ok(explain);
  assert.match(explain!.prompt, /method POST is ALLOW/);
  assert.doesNotMatch(explain!.prompt, /\bis BLOCK\b/);
  assertPublicEnglishSurface(explain!.prompt);
});

test("C3-005: openapi.json is listed next to openapi.yaml in llms.txt and /docs/api", () => {
  const llms = read("public/llms.txt");
  assert.ok(llms.includes("https://vet402.com/openapi.json"));
  const docs = read("src/app/docs/api/page.tsx");
  assert.match(docs, /href="\/openapi\.json"/);
});

test("G3 confidentiality: Referrer-Policy header and first-party site-events wire format", () => {
  const cfg = read("next.config.ts");
  assert.match(cfg, /Referrer-Policy.*strict-origin-when-cross-origin/);
  const analytics = read("src/lib/analytics.ts");
  assert.match(analytics, /sends \{e,p,r\}/);
  assert.match(analytics, /JSON\.stringify\(payload\)/);
  assert.doesNotMatch(analytics, /paste|query|searchParams/i);
});

test("G3: explorer link from home paste check uses noreferrer", () => {
  const paste = read("src/components/site/home/PasteCheck.tsx");
  assert.match(paste, /rel="noopener noreferrer"/);
});
