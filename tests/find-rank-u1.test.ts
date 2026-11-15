import { test } from "node:test";
import assert from "node:assert/strict";
import type { FindListing } from "@/lib/find/reads";
import { FIND_MAX_ALTERNATIVES, rankFindAlternatives, sameListingUrl, wilsonLower } from "@/lib/find/rank";
import { termsOfUrl } from "@/lib/find/terms";

function listing(
  partial: Partial<FindListing> & Pick<FindListing, "url" | "resourceKey" | "delivered30d" | "paidAttempts30d">,
): FindListing {
  return {
    observatoryId: partial.observatoryId ?? "1",
    description: partial.description ?? null,
    priceAmount: partial.priceAmount ?? null,
    network: partial.network ?? "eip155:8453",
    lastAttemptAt: partial.lastAttemptAt ?? "2026-11-01T12:00:00.000Z",
    ...partial,
  };
}

test("termsOfUrl examples", () => {
  assert.deepEqual(termsOfUrl("https://api.example.com/v1/weather/forecast"), ["forecast", "weather"]);
  assert.deepEqual(termsOfUrl("https://api.exa.ai/search"), ["search"]);
  assert.deepEqual(termsOfUrl("https://x.example.com/api/v2/0xabc/123"), []);
  assert.deepEqual(termsOfUrl("http://api.example.com/v1/weather"), []);
  assert.deepEqual(termsOfUrl("not-a-url"), []);
  assert.deepEqual(termsOfUrl("https://weather.x402.example.com/"), ["weather"]);
  assert.deepEqual(termsOfUrl("https://api.example.com/"), []);
});

test("sameListingUrl ignores scheme, trailing slash and query", () => {
  assert.equal(
    sameListingUrl("https://API.example.com/path/", "http://api.example.com/path?q=1"),
    true,
  );
});

test("rank drops low rate, no paid test, and same URL", () => {
  const pasted = "https://api.example.com/v1/quote";
  const pool = [
    listing({
      url: "https://low.example/a",
      resourceKey: "low.example/a",
      delivered30d: 3,
      paidAttempts30d: 10,
      observatoryId: "a",
    }),
    listing({
      url: pasted,
      resourceKey: "api.example.com/v1/quote",
      delivered30d: 20,
      paidAttempts30d: 20,
      observatoryId: "b",
    }),
    listing({
      url: "https://none.example/c",
      resourceKey: "none.example/c",
      delivered30d: 0,
      paidAttempts30d: 0,
      observatoryId: "c",
    }),
    listing({
      url: "https://good.example/d",
      resourceKey: "good.example/d",
      delivered30d: 18,
      paidAttempts30d: 20,
      observatoryId: "d",
    }),
  ];
  const { alternatives, dropped } = rankFindAlternatives(pool, pasted);
  assert.equal(dropped.lowRate, 1);
  assert.equal(dropped.sameUrl, 1);
  assert.equal(dropped.noPaidTest, 1);
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0]!.url, "https://good.example/d");
});

test("20 of 20 ranks above 1 of 1 even when low rate is first in pool", () => {
  const lowFirst = [
    listing({
      url: "https://a.example/1",
      resourceKey: "a.example/1",
      delivered30d: 3,
      paidAttempts30d: 10,
      observatoryId: "1",
    }),
    listing({
      url: "https://b.example/2",
      resourceKey: "b.example/2",
      delivered30d: 1,
      paidAttempts30d: 1,
      observatoryId: "2",
    }),
    listing({
      url: "https://c.example/3",
      resourceKey: "c.example/3",
      delivered30d: 20,
      paidAttempts30d: 20,
      observatoryId: "3",
    }),
  ];
  const { alternatives } = rankFindAlternatives(lowFirst, null);
  assert.equal(alternatives[0]!.delivered30d, 20);
  assert.equal(alternatives[0]!.paidAttempts30d, 20);
  assert.ok(wilsonLower(20, 20) > wilsonLower(1, 1));
});

test("80% boundary: 8/10 stays, 79/100 drops", () => {
  const pool = [
    listing({
      url: "https://edge-pass.example/a",
      resourceKey: "edge-pass.example/a",
      delivered30d: 8,
      paidAttempts30d: 10,
      observatoryId: "p",
    }),
    listing({
      url: "https://edge-fail.example/b",
      resourceKey: "edge-fail.example/b",
      delivered30d: 79,
      paidAttempts30d: 100,
      observatoryId: "f",
    }),
  ];
  const { alternatives, dropped } = rankFindAlternatives(pool, null);
  assert.equal(dropped.lowRate, 1);
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0]!.url, "https://edge-pass.example/a");
});

test("low rate drops before Wilson rank even when Wilson would beat 1/1", () => {
  const pool = [
    listing({
      url: "https://huge-low.example/a",
      resourceKey: "huge-low.example/a",
      delivered30d: 70,
      paidAttempts30d: 100,
      observatoryId: "h",
    }),
    listing({
      url: "https://tiny-good.example/b",
      resourceKey: "tiny-good.example/b",
      delivered30d: 1,
      paidAttempts30d: 1,
      observatoryId: "t",
    }),
  ];
  assert.ok(wilsonLower(70, 100) > wilsonLower(1, 1));
  const { alternatives, dropped } = rankFindAlternatives(pool, null);
  assert.equal(dropped.lowRate, 1);
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0]!.url, "https://tiny-good.example/b");
});

test("duplicate resource_key folds to higher Wilson bound", () => {
  const pool = [
    listing({
      url: "https://dup.example/x",
      resourceKey: "dup.example/x",
      delivered30d: 49,
      paidAttempts30d: 50,
      observatoryId: "1",
    }),
    listing({
      url: "https://dup.example/x?v=2",
      resourceKey: "dup.example/x",
      delivered30d: 1,
      paidAttempts30d: 1,
      observatoryId: "2",
    }),
    listing({
      url: "https://other.example/y",
      resourceKey: "other.example/y",
      delivered30d: 8,
      paidAttempts30d: 10,
      observatoryId: "3",
    }),
  ];
  const { alternatives } = rankFindAlternatives(pool, null);
  const dup = alternatives.filter((a) => a.resourceKey === "dup.example/x");
  assert.equal(dup.length, 1);
  assert.equal(dup[0]!.delivered30d, 49);
  assert.equal(dup[0]!.paidAttempts30d, 50);
});

test("different resource_key keeps both URLs even under the same host", () => {
  const pool = [
    listing({
      url: "https://host.example/a",
      resourceKey: "host.example/a",
      delivered30d: 9,
      paidAttempts30d: 10,
      observatoryId: "1",
    }),
    listing({
      url: "https://host.example/b",
      resourceKey: "host.example/b",
      delivered30d: 8,
      paidAttempts30d: 10,
      observatoryId: "2",
    }),
  ];
  const { alternatives } = rankFindAlternatives(pool, null);
  assert.equal(alternatives.length, 2);
});

test("at most three unique URLs", () => {
  const pool = Array.from({ length: 8 }, (_, i) =>
    listing({
      url: `https://x.example/${i}`,
      resourceKey: `x.example/${i}`,
      delivered30d: 10 + i,
      paidAttempts30d: 10 + i,
      observatoryId: String(i),
    }),
  );
  pool.push(
    listing({
      url: "https://x.example/1",
      resourceKey: "x.example/1",
      delivered30d: 99,
      paidAttempts30d: 100,
      observatoryId: "dup",
    }),
  );
  const { alternatives } = rankFindAlternatives(pool, null);
  assert.equal(alternatives.length, FIND_MAX_ALTERNATIVES);
  const keys = new Set(alternatives.map((a) => a.resourceKey));
  assert.equal(keys.size, FIND_MAX_ALTERNATIVES);
});