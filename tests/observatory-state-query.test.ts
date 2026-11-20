import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

delete process.env.DATABASE_URL;

test("GET /api/v1/observatory/state rejects unknown query parameters", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/observatory/state?foo=1", {
      headers: { "x-forwarded-for": "203.0.113.92" },
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_query");
});