import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setDbForTests } from "@/lib/db/client";
import { readWatchSellersInterest } from "@/lib/site-interest-stats";
import { pathGroup } from "@/lib/site-events";

test("readWatchSellersInterest sums watch_sellers_interest", async () => {
  __setDbForTests({
    execute: async () => ({
      rows: [{ total: 7 }],
    }),
  });
  const out = await readWatchSellersInterest(14);
  assert.equal(out.days, 14);
  assert.equal(out.watch_sellers_interest, 7);
  __setDbForTests(null);
});

test("readWatchSellersInterest defaults days to clamped range", async () => {
  __setDbForTests({
    execute: async () => ({ rows: [{ total: 0 }] }),
  });
  const out = await readWatchSellersInterest(999);
  assert.equal(out.days, 365);
  __setDbForTests(null);
});

test("reputation paths group under /x402/sellers/[host]", () => {
  assert.equal(pathGroup("/x402/sellers/shop.example"), "/x402/sellers/[host]");
});

test("keyless check route records rate_limited on 429 branch", () => {
  const src = readFileSync("src/lib/api/keyless-check-route.ts", "utf8");
  assert.match(src, /gate\.response\.status === 429/);
  assert.match(src, /recordRateLimitedClientUsage\(usageRoute\)/);
});

test("WatchSellersInterest fires watch_sellers_interest with seller_page", () => {
  const src = readFileSync("src/components/site/sellers/WatchSellersInterest.tsx", "utf8");
  assert.match(src, /watch_sellers_interest/);
  assert.match(src, /seller_page/);
  assert.match(src, /I would use this/);
  assert.doesNotMatch(src, /we'll|we will|we are building/i);
});