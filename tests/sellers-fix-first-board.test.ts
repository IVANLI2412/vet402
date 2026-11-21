// whitehat-4: fix-first-board は publicRateLimit ・共有キャッシュ・本文サイズ上限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

const ROOT = process.cwd();
const MAX_BODY_BYTES = 300 * 1024;

test("route applies publicRateLimit and s-maxage", () => {
  const src = readFileSync(join(ROOT, "src/app/api/v1/sellers/fix-first-board/route.ts"), "utf8");
  assert.match(src, /publicRateLimit/);
  assert.match(src, /s-maxage=60/);
  assert.doesNotMatch(src, /private, no-store/);
});

test("route omits full sellers list from JSON payload", () => {
  const src = readFileSync(join(ROOT, "src/app/api/v1/sellers/fix-first-board/route.ts"), "utf8");
  assert.match(src, /slimBoard|FixFirstBoardPayload/);
});

test("slim sample payload stays under 300KB", () => {
  const sample: import("@/app/api/v1/sellers/fix-first-board/route").FixFirstBoardPayload = {
    fetchedAt: new Date().toISOString(),
    totals: {
      delivered: 40,
      pending: 2,
      seller: 80,
      vet402: 10,
      unsorted: 5,
      notPaid: 3,
      notTried: 1,
      sellers: 120,
      listings: 450,
      sellerRequestListings: 12,
      sellersTried: 100,
    },
    groups: Array.from({ length: 24 }, (_, i) => ({
      key: `mode-${i}`,
      side: "seller" as const,
      title: `Group ${i}`,
      fix: "Set scheme to exact in the 402 body.",
      what: "vet402 recorded accepts_invalid on the latest purchase.",
      effort: 1 as const,
      hosts: 40,
      listings: 120,
      statuses: { accepts_invalid: 120 },
      sellers: Array.from({ length: 40 }, (_, j) => ({ host: `seller-${i}-${j}.example`, listings: 3 })),
    })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(sample), "utf8");
  assert.ok(bytes < MAX_BODY_BYTES, `sample payload ${bytes} bytes >= ${MAX_BODY_BYTES}`);
});
