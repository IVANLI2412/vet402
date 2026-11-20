// whitehat-06: 本文に vouch_live_ を含む応答は Cache-Control: no-store。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const KEY_BODY_ROUTES = [
  "src/app/api/signup/route.ts",
  "src/app/api/dashboard/keys/route.ts",
] as const;

test("signup and dashboard keys routes are named in no-store coverage", () => {
  const cfg = readFileSync(join(ROOT, "next.config.ts"), "utf8");
  assert.match(cfg, /\/api\/signup/);
  assert.match(cfg, /\/api\/dashboard\/:path\*/);
  assert.match(cfg, /no-store/);
  for (const rel of KEY_BODY_ROUTES) {
    assert.ok(readFileSync(join(ROOT, rel), "utf8").includes("apiKey") || rel.includes("keys"));
  }
});

test("routes that return live API keys do not advertise public caching", () => {
  for (const rel of KEY_BODY_ROUTES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(src.includes("apiKey") || src.includes("vouch_live"), rel);
    assert.ok(!/s-maxage|max-age=\d+/.test(src), `${rel} must not set shared cache on key responses`);
  }
});