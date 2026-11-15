import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FindListing } from "@/lib/find/reads";
import { FIND_RULE, handleFind, type FindDeps } from "@/lib/find/find-handler";
import { searchLikePattern } from "@/lib/observatory/reader";
import { FIND_POOL_SIZE, rankFindAlternatives } from "@/lib/find/rank";
import { beforePaySnippets, BEFORE_PAY_MCP_LINE } from "@/lib/find/snippets";

function row(partial: Partial<FindListing> & Pick<FindListing, "url" | "resourceKey">): FindListing {
  return {
    observatoryId: partial.observatoryId ?? partial.url,
    description: partial.description ?? "Search API",
    priceAmount: partial.priceAmount ?? "10000",
    network: partial.network ?? "eip155:8453",
    delivered30d: partial.delivered30d ?? 20,
    paidAttempts30d: partial.paidAttempts30d ?? 20,
    lastAttemptAt: partial.lastAttemptAt ?? "2026-11-10T10:00:00.000Z",
    ...partial,
  };
}

function deps(findAlternatives: FindDeps["findAlternatives"]): FindDeps {
  return { findAlternatives };
}

test("handleFind: empty terms skips DB", async () => {
  let calls = 0;
  const res = await handleFind(new Request("https://vet402.com/api/v1/find?url=https://x.example.com/api/v2/0xabc/123"), deps(async () => {
    calls++;
    return { fetchedAt: new Date().toISOString(), listings: [] };
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.query_terms, []);
  assert.deepEqual(body.alternatives, []);
  assert.equal(calls, 0);
});

test("handleFind: invalid query when both url and q", async () => {
  const res = await handleFind(
    new Request("https://vet402.com/api/v1/find?url=https://a.example/x&q=search"),
    deps(async () => ({ fetchedAt: "", listings: [] })),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_query");
});

test("handleFind: two words in the URL still calls findAlternatives once", async () => {
  let calls = 0;
  const likes: string[] = [];
  const res = await handleFind(
    new Request("https://vet402.com/api/v1/find?url=https://api.example.com/v1/weather/forecast"),
    deps(async (like, limit) => {
      calls++;
      likes.push(like);
      assert.equal(limit, FIND_POOL_SIZE);
      return {
        fetchedAt: "2026-11-10T11:00:00.000Z",
        listings: [
          row({
            url: "https://other.example/search",
            resourceKey: "other.example/search",
            observatoryId: "1",
            delivered30d: 5,
            paidAttempts30d: 5,
          }),
        ],
      };
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(likes, [searchLikePattern("forecast")]);
  const body = await res.json();
  assert.deepEqual(body.query_terms, ["forecast"]);
  assert.equal(body.rule, FIND_RULE);
  assert.equal(body.window_days, 30);
});

test("handleFind: q under 3 or over 80 is invalid_query without DB", async () => {
  let calls = 0;
  for (const q of ["ab", " a "]) {
    const res = await handleFind(new Request(`https://vet402.com/api/v1/find?q=${encodeURIComponent(q)}`), deps(async () => {
      calls++;
      return { fetchedAt: "", listings: [] };
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_query");
  }
  assert.equal(calls, 0);
});

test("handleFind: q with three characters calls findAlternatives once", async () => {
  let calls = 0;
  const res = await handleFind(new Request("https://vet402.com/api/v1/find?q=abc"), deps(async (like, limit) => {
    calls++;
    assert.equal(like, searchLikePattern("abc"));
    assert.equal(limit, FIND_POOL_SIZE);
    return { fetchedAt: "2026-11-10T11:00:00.000Z", listings: [] };
  }));
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  const body = await res.json();
  assert.deepEqual(body.query_terms, ["abc"]);
});

test("handleFind: one call when first term already fills three slots", async () => {
  let calls = 0;
  const res = await handleFind(
    new Request("https://vet402.com/api/v1/find?url=https://api.example.com/v1/weather/forecast"),
    deps(async (_like, limit) => {
      calls++;
      assert.equal(limit, FIND_POOL_SIZE);
      return {
        fetchedAt: "2026-11-10T11:00:00.000Z",
        listings: [
          row({ url: "https://a.example/1", resourceKey: "a.example/1", observatoryId: "1", delivered30d: 30, paidAttempts30d: 30 }),
          row({ url: "https://a.example/2", resourceKey: "a.example/2", observatoryId: "2", delivered30d: 29, paidAttempts30d: 30 }),
          row({ url: "https://a.example/3", resourceKey: "a.example/3", observatoryId: "3", delivered30d: 28, paidAttempts30d: 30 }),
        ],
      };
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  const body = await res.json();
  assert.equal(body.alternatives.length, 3);
});

test("handler ranking matches rankFindAlternatives on fake data", async () => {
  const pasted = "https://api.example.com/v1/quote";
  const listings = [
    row({
      url: pasted,
      resourceKey: "api.example.com/v1/quote",
      delivered30d: 20,
      paidAttempts30d: 20,
      observatoryId: "same",
    }),
    row({
      url: "https://alt.example/search",
      resourceKey: "alt.example/search",
      delivered30d: 4,
      paidAttempts30d: 10,
      observatoryId: "low",
    }),
    row({
      url: "https://best.example/search",
      resourceKey: "best.example/search",
      delivered30d: 20,
      paidAttempts30d: 20,
      observatoryId: "best",
    }),
  ];
  const res = await handleFind(new Request(`https://vet402.com/api/v1/find?url=${encodeURIComponent(pasted)}`), deps(async () => ({
    fetchedAt: "2026-11-10T12:00:00.000Z",
    listings,
  })));
  const body = await res.json();
  assert.equal(body.alternatives.length, 1);
  assert.equal(body.alternatives[0]?.url, "https://best.example/search");
  // 低率と未試験は SQL で先に落とすので、応答に「落とした件数」を載せない（常に 0 と読まれるため）。
  assert.ok(!("dropped" in body));
  assert.ok(!("untested_not_shown" in body));
});

test("snippets match vet402 export, check route, and MCP connect line", () => {
  const SAMPLE = "https://api.example.com/v1/quote";
  const pkg = readFileSync("packages/vet402/src/index.ts", "utf8");
  assert.match(pkg, /export \{[\s\S]*check/);
  assert.ok(readFileSync("src/app/api/v1/check/route.ts", "utf8").includes("handleCheck"));
  const connect = readFileSync("src/lib/connect/snippets.ts", "utf8");
  assert.ok(connect.includes(BEFORE_PAY_MCP_LINE));
  const snippets = beforePaySnippets(SAMPLE);
  const ts = snippets.find((s) => s.id === "ts")!;
  assert.equal(ts.code, `import { check } from "vet402"; const r = await check(${JSON.stringify(SAMPLE)});`);
  const curl = snippets.find((s) => s.id === "curl")!;
  assert.match(curl.code, /^curl -s "https:\/\/vet402\.com\/api\/v1\/check\?url=/);
  const mcp = snippets.find((s) => s.id === "mcp")!;
  assert.equal(mcp.code, BEFORE_PAY_MCP_LINE);
});

test("curl snippet encodes reserved query characters", () => {
  const nasty = "https://api.example.com/v1/quote!(')*";
  const snippets = beforePaySnippets(nasty);
  const curl = snippets.find((s) => s.id === "curl")!;
  assert.match(curl.code, /%21|%28|%29|%2A/);
  assert.doesNotMatch(curl.code, /[!'()*]/);
});
test("handleFind: the cached body does not echo the pasted query string or userinfo", async () => {
  const withUser = await handleFind(
    new Request(`https://vet402.com/api/v1/find?url=${encodeURIComponent("https://user:secret@api.example.com/v1/weather")}`),
    deps(async () => ({ fetchedAt: new Date().toISOString(), listings: [] })),
  );
  assert.equal(withUser.status, 400);
  assert.doesNotMatch(await withUser.text(), /secret/);
  const pasted = "https://api.example.com/v1/weather?key=sk_live_x&email=a%40b.example#frag";
  const res = await handleFind(new Request(`https://vet402.com/api/v1/find?url=${encodeURIComponent(pasted)}`), deps(async () => ({
    fetchedAt: new Date().toISOString(),
    listings: [],
  })));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /secret|sk_live_x|a%40b|a@b|frag|user:/);
  assert.equal(JSON.parse(text).input, "https://api.example.com/v1/weather");
});