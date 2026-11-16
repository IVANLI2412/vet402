import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setDbForTests } from "@/lib/db/client";
import { readReferralPageViews } from "@/lib/site-referral-stats";

test("readReferralPageViews aggregates page_view by source label", async () => {
  __setDbForTests({
    execute: async () => ({
      rows: [
        { source: "x", page_views: 12 },
        { source: "direct", page_views: 40 },
      ],
    }),
  });
  const out = await readReferralPageViews(7);
  assert.equal(out.days, 7);
  assert.deepEqual(out.by_source, [
    { source: "x", page_views: 12 },
    { source: "direct", page_views: 40 },
  ]);
  __setDbForTests(null);
});

test("readReferralPageViews clamps days", async () => {
  __setDbForTests({
    execute: async () => ({ rows: [] }),
  });
  const out = await readReferralPageViews(999);
  assert.equal(out.days, 365);
  __setDbForTests(null);
});

test("PageViewBeacon sends document referrer host for first paint", () => {
  const src = readFileSync("src/components/site/PageViewBeacon.tsx", "utf8");
  assert.match(src, /new URL\(ref\)\.hostname/);
  assert.match(src, /page_view/);
});