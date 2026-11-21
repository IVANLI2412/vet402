// C-6: every /api route answers disallowed verbs with the shared 405 JSON envelope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { API_DOCS_URL } from "@/lib/api/method-not-allowed";

const ROOT = process.cwd();
const API_ROOT = join(ROOT, "src/app/api");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const SKIP = new Set([
  "src/app/api/mcp/route.ts",
  "src/app/api/[...unmatched]/route.ts",
  "src/app/api/v1/guarantee/quote/route.ts",
]);

function listRoutes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listRoutes(full, acc);
    else if (entry.name === "route.ts" || entry.name === "route.tsx") acc.push(full);
  }
  return acc;
}

function allowedMethods(src: string): Set<string> {
  const allowed = new Set<string>();
  for (const m of METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src)) allowed.add(m);
    if (new RegExp(`export\\s+const\\s+${m}\\s*=`).test(src) && !src.includes(`export const { ${m}`)) {
      allowed.add(m);
    }
  }
  const block = src.match(/exportDisallowedMethodHandlers\(\[([^\]]*)\]\)/);
  if (block) {
    for (const raw of block[1].split(",")) {
      const m = raw.trim().replace(/['"]/g, "");
      if (m) allowed.add(m.toUpperCase());
    }
  }
  return allowed;
}

function routeImportPath(file: string): string {
  const rel = relative(join(ROOT, "src/app"), file).replace(/\.tsx?$/, "");
  return `@/app/${rel}`;
}

function pathFromFile(file: string): string {
  const rel = relative(join(ROOT, "src/app"), file).replace(/\/route\.tsx?$/, "");
  return `/${rel}`;
}

test("disallowed HTTP methods return the shared method_not_allowed JSON", async () => {
  const failures: string[] = [];
  for (const file of listRoutes(API_ROOT)) {
    const rel = relative(ROOT, file);
    if (SKIP.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    const allowed = allowedMethods(src);
    const disallowed = METHODS.filter((m) => !allowed.has(m));
    if (disallowed.length === 0) continue;

    const mod = await import(routeImportPath(file));
    const verb = disallowed[0];
    const handler = mod[verb];
    if (typeof handler !== "function") {
      failures.push(`${rel}: missing export ${verb}`);
      continue;
    }

    const url = `http://localhost${pathFromFile(file)}`;
    const init = verb === "GET" || verb === "HEAD" ? { method: verb } : { method: verb, body: "{}" };
    const res = await handler(new NextRequest(url, init));
    const allow = res.headers.get("allow") ?? "";
    const ct = res.headers.get("content-type") ?? "";
    if (res.status !== 405) failures.push(`${rel} ${verb}: status ${res.status}`);
    if (!ct.includes("application/json")) failures.push(`${rel} ${verb}: content-type ${ct}`);
    const body = await res.json();
    if (body.error !== "method_not_allowed") failures.push(`${rel} ${verb}: error ${body.error}`);
    if (body.documentation !== API_DOCS_URL) failures.push(`${rel} ${verb}: documentation`);
    const expectedAllow = [...allowed].map((m) => m.toUpperCase()).sort();
    const gotAllow = allow.split(/,\s*/).filter(Boolean).sort();
    if (JSON.stringify(gotAllow) !== JSON.stringify(expectedAllow)) {
      failures.push(`${rel} ${verb}: Allow ${allow}`);
    }
    if (!Array.isArray(body.allowed) || JSON.stringify([...body.allowed].sort()) !== JSON.stringify(expectedAllow)) {
      failures.push(`${rel} ${verb}: allowed array`);
    }
  }
  assert.deepEqual(failures, []);
});

test("observatory export days redirect returns JSON moved body", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  try {
    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const res = await GET(
      new NextRequest("http://localhost/api/v1/observatory/export.csv?days=0", {
        headers: { "x-real-ip": "203.0.113.88" },
      }),
    );
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
    const body = await res.json();
    assert.equal(body.error, "moved");
    assert.match(body.location ?? "", /\?days=1$/);
    assert.match(res.headers.get("location") ?? "", /\?days=1$/);
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
  }
});