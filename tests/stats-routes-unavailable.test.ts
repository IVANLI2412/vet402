import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

delete process.env.DATABASE_URL;

const ROUTES = [
  { path: "@/app/api/v1/stats/interest/route", url: "http://localhost/api/v1/stats/interest" },
  { path: "@/app/api/v1/stats/referrals/route", url: "http://localhost/api/v1/stats/referrals" },
  { path: "@/app/api/v1/stats/badge-fetches/route", url: "http://localhost/api/v1/stats/badge-fetches?days=7" },
  { path: "@/app/api/v1/stats/keyless-callers/route", url: "http://localhost/api/v1/stats/keyless-callers" },
] as const;

for (const { path, url } of ROUTES) {
  test(`${url} returns 503 when the database is unavailable`, async () => {
    const { GET } = await import(path);
    const res = await GET(new NextRequest(url, { headers: { "x-forwarded-for": "203.0.113.44" } }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "temporarily_unavailable");
  });
}

test("badge-fetches clamps days before checking the database", async () => {
  const { GET } = await import("@/app/api/v1/stats/badge-fetches/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/stats/badge-fetches?days=9999", {
      headers: { "x-forwarded-for": "203.0.113.45" },
    }),
  );
  assert.equal(res.status, 503);
});