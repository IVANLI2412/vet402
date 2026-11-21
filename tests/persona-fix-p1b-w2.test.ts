// W2 persona audit fixes: API, docs, security (2026-11-21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { verdictNextStep } from "@/lib/decision/verdict-next-step";
import { MCP_FIRST_PROMPTS } from "@/lib/docs/mcp-first-prompts";
import { assertPublicEnglishSurface } from "@/lib/v4/public-english";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("C4-001: /api/v1/resolve invalid q returns private, no-store", async () => {
  const { GET } = await import("@/app/api/v1/resolve/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/resolve"));
  assert.equal(res.status, 400);
  assert.match(res.headers.get("cache-control") ?? "", /private,\s*no-store/);
});

test("C3-001: /openapi.json route serves JSON with openapi version", async () => {
  const { GET } = await import("@/app/openapi.json/route");
  const res = await GET();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { openapi?: string };
  assert.equal(body.openapi, "3.1.0");
});

test("C3-002/C3-003: CheckSellerDocument lists next_action", () => {
  const spec = read("docs/openapi.yaml");
  assert.match(spec, /CheckSellerDocument:/);
  assert.match(spec, /next_action:/);
  assert.match(spec, /checkX402Seller[\s\S]*\$ref: "#\/components\/schemas\/CheckSellerDocument"/);
});

test("C5-003: /api/v1/health aliases main health handler", async () => {
  const { GET: v1 } = await import("@/app/api/v1/health/route");
  const { GET: root } = await import("@/app/api/health/route");
  const req = new NextRequest("http://localhost/api/v1/health");
  const a = await v1(req);
  const b = await root(new NextRequest("http://localhost/api/health"));
  assert.equal(a.status, b.status);
  assert.deepEqual(await a.json(), await b.json());
});

test("G1-002/G1-003: MCP first prompts are runnable without placeholders", () => {
  for (const p of MCP_FIRST_PROMPTS) {
    assert.doesNotMatch(p.prompt, /\{paste\}|\{tx\}/, p.id);
  }
  assert.ok(MCP_FIRST_PROMPTS.some((p) => p.prompt.includes("method POST")));
  assert.ok(MCP_FIRST_PROMPTS.some((p) => p.prompt.includes("0x3978fbe3")));
});

test("G1-004: verdict next step is plain English", () => {
  for (const line of [
    verdictNextStep("ALLOW"),
    verdictNextStep("WARN"),
    verdictNextStep("WARN", ["l1_latest_failed"]),
    verdictNextStep("BLOCK"),
  ]) {
    assertPublicEnglishSurface(line);
    assert.doesNotMatch(line, /402 in hand|verified terms/i);
  }
});

test("G1-005: keyless doc paths relabel signup CTA in SiteHeader", () => {
  const src = read("src/components/site/SiteHeader.tsx");
  assert.match(src, /Free key \(extra scores\)/);
  assert.match(src, /KEYLESS_DOC_PATHS/);
});

test("C4-002: key-less rate limit docs name RateLimit-* for IP window", () => {
  const docs = read("src/components/docs/ApiDocsRest.tsx");
  assert.match(docs, /key-less paths return[\s\S]*RateLimit-Limit/);
  assert.match(docs, /not <code>X-RateLimit-\*<\/code>/);
});