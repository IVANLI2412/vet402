// 2026-11-16 PMF API: check/decision alias, diagnose_url, RateLimit headers, input 400 vs 503.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { handleCheck } from "@/lib/api/check-handler";
import { diagnoseUrlFor } from "@/lib/api/diagnose-url";
import { RESOLVE_KEYLESS_LIMIT } from "@/lib/api/keyless-limits";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import { GET as getCheck } from "@/app/api/v1/check/route";
import { GET as getDecision } from "@/app/api/v1/decision/route";
import { __setDbForTests } from "@/lib/db/client";
import type { McpDeps } from "@/lib/mcp/tools";

const URL = "https://api.example.org/x";

function fakeDeps(found: boolean): McpDeps {
  return {
    now: () => new Date("2026-11-16T00:00:00.000Z"),
    resolve: (async () =>
      found
        ? {
            resource: {
              observatory_id: "00000000-0000-0000-0000-000000000001",
              canonical_url: URL,
              method: "GET",
            },
            endpoints: [],
          }
        : { resource: null, endpoints: [] }) as unknown as McpDeps["resolve"],
    decide: (async () => ({
      recommendation: "ALLOW",
      reason_codes: [],
      reasons: [],
      facts: { l1: { n_attempts: 1, n_delivered: 1 } },
      scoredAt: "2026-11-16T00:00:00.000Z",
      freshness: { l0: null, l1: null, l2: null },
      spending_halted: false,
      evidence_age: null,
    })) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps;
}

test("not_in_catalog answers include diagnose_url", async () => {
  const res = await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL)}`), fakeDeps(false));
  const body = await res.json();
  assert.equal(body.not_in_catalog, true);
  assert.equal(body.diagnose_url, diagnoseUrlFor(URL));
});

test("invalid url inputs answer 400, not 503", async () => {
  const deps = fakeDeps(true);
  for (const qs of [
    "",
    "?url=",
    "?url=not-a-url",
    "?url=ftp%3A%2F%2Fx",
    "?url=http%3A%2F%2Fapi.example.org%2Fx",
    `?url=${"https://a.example/".repeat(200)}`,
  ]) {
    const res = await handleCheck(new Request(`https://vet402.com/api/v1/check${qs}`), deps);
    assert.equal(res.status, 400, qs);
  }
});

test("reader failure answers 503", async () => {
  const deps = fakeDeps(false);
  (deps as { resolve: unknown }).resolve = async () => {
    throw new Error("db down");
  };
  const res = await handleCheck(
    new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL)}`),
    deps,
  );
  assert.equal(res.status, 503);
});

test("decision route is a thin alias of check", () => {
  const src = readFileSync("src/app/api/v1/decision/route.ts", "utf8");
  assert.ok(src.includes("handleKeylessCheckRoute"));
  assert.ok(!src.includes("checkSeller"));
});

test("check and decision routes share one handler", () => {
  const check = readFileSync("src/app/api/v1/check/route.ts", "utf8");
  const decision = readFileSync("src/app/api/v1/decision/route.ts", "utf8");
  assert.ok(check.includes("handleKeylessCheckRoute"));
  assert.ok(check.includes("rest:check"));
  assert.ok(decision.includes("handleKeylessCheckRoute"));
  assert.ok(decision.includes("rest:decision"));
  const shared = readFileSync("src/lib/api/keyless-check-route.ts", "utf8");
  assert.ok(shared.includes("handleCheck"));
});

test("RateLimit-Policy is wired on the shared handler", () => {
  const src = readFileSync("src/lib/api/keyless-check-route.ts", "utf8");
  assert.match(src, /RateLimit-Policy/);
  assert.ok(src.includes("RESOLVE_KEYLESS_LIMIT"));
});

const RATE_HEADERS = ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "RateLimit-Policy"] as const;

afterEach(() => setMcpDepsForTest(null));

function keylessDeps(): McpDeps {
  return fakeDeps(false);
}

test("check and decision return four RateLimit headers on 200", async () => {
  setMcpDepsForTest(keylessDeps());
  const url = `https://vet402.com/api/v1/check?url=${encodeURIComponent(URL)}`;
  for (const handler of [getCheck, getDecision]) {
    const res = await handler(new NextRequest(url, { headers: { "x-forwarded-for": "198.51.100.4" } }));
    assert.equal(res.status, 200);
    for (const name of RATE_HEADERS) assert.ok(res.headers.get(name), `${name} on 200`);
    assert.match(res.headers.get("cache-control") ?? "", /private,\s*no-store/);
  }
});

test("check and decision return four RateLimit headers on 429", async () => {
  setMcpDepsForTest(keylessDeps());
  const url = `https://vet402.com/api/v1/check?url=${encodeURIComponent(URL)}`;
  const headers = { "x-forwarded-for": "198.51.100.5" };
  for (let i = 0; i < RESOLVE_KEYLESS_LIMIT; i++) {
    await getCheck(new NextRequest(url, { headers }));
  }
  for (const handler of [getCheck, getDecision]) {
    const res = await handler(new NextRequest(url, { headers }));
    assert.equal(res.status, 429);
    for (const name of RATE_HEADERS) assert.ok(res.headers.get(name), `${name} on 429`);
    assert.match(res.headers.get("cache-control") ?? "", /private,\s*no-store/);
  }
});

test("close-keyless-week cron returns 403 without auth", async () => {
  const { GET } = await import("@/app/api/cron/close-keyless-week/route");
  const res = await GET(new NextRequest("https://vet402.com/api/cron/close-keyless-week") as never);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "forbidden");
});

test("close-keyless-week cron hides error details on 500", async () => {
  const { GET } = await import("@/app/api/cron/close-keyless-week/route");
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.DATABASE_URL ??= "postgres://unused";
  __setDbForTests({
    execute: async () => Promise.reject(new Error("db secret detail")),
  } as never);
  try {
    const req = new NextRequest("https://vet402.com/api/cron/close-keyless-week", {
      headers: { authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req as never);
    assert.equal(res.status, 500);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { ok: false });
  } finally {
    __setDbForTests(null);
  }
});