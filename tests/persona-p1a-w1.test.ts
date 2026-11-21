// Persona audit P1 — workstream W1 (seller pages, completeness, home paste overlap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSellerDetail } from "@/lib/sellers/board";
import { reputationHeadline } from "@/lib/sellers/reputation";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const delivered: SellerRowFacts = {
  endpointId: "e1",
  status: "settled",
  httpStatusPaid: 200,
  txHash: "0x" + "aa".repeat(32),
  attemptedAt: "2026-08-01T12:00:00Z",
  network: "eip155:8453",
  method: "GET",
  meta: null,
  schema: null,
  unpaidStatus: null,
  selection: null,
  verifyReason: null,
};

test("G3-001: FixFirstPreview lists seller-side and vet402-side under separate headings", () => {
  const src = read("src/components/site/sellers/FixFirstPreview.tsx");
  assert.match(src, /g\.side === "seller"/);
  assert.match(src, /g\.side === "vet402"/);
  assert.match(src, /On the seller/);
  assert.match(src, /On vet402/);
  assert.doesNotMatch(src, /first sellers in the ledger/);
  assert.match(src, /AttributionReviewNote/);
});

test("G3-002: DecisionAnswer treats no Base purchase as not a WARN headline", () => {
  const src = read("src/components/site/sellers/DecisionAnswer.tsx");
  assert.match(src, /noBasePurchase/);
  assert.match(src, /No paid test on Base yet/);
  assert.match(read("src/components/site/sellers/SellersViews.tsx"), /noBasePurchase=\{!r\}/);
});

test("G3-003: stale reputation headline drops WARN; missing hosts redirect to /sellers", () => {
  const stale = buildSellerDetail(
    "krono.example",
    [
      { endpointId: "e1", resourceKey: "krono.example/a", resourceUrl: "https://krono.example/a", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "krono.example/b", resourceUrl: "https://krono.example/b", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-08-02T12:00:00Z" }],
    "2026-11-21T00:00:00Z",
  );
  const headline = reputationHeadline("krono.example", stale);
  assert.doesNotMatch(headline, /\bWARN\b/);
  assert.match(headline, /older than 30 days/);
  const page = read("src/app/x402/sellers/[host]/page.tsx");
  assert.match(page, /redirect\(sellerPath\(host\)\)/);
});

test("G3-004: seller host page uses neutral listings heading", () => {
  assert.match(read("src/components/site/sellers/SellersViews.tsx"), /Listings for this host/);
  assert.doesNotMatch(read("src/components/site/sellers/SellersViews.tsx"), /<span>Your listings<\/span>/);
});

test("C5-002: state HTML mentions spendingHalted and lastAttemptAt", () => {
  const page = read("src/app/observatory/state/page.tsx");
  assert.match(page, /isSpendingHalted/);
  assert.match(page, /lastAttemptAt/);
  assert.match(page, /spendingHalted\.halted/);
});

test("G2-002: home four-count caption uses full readAt ISO", () => {
  assert.match(read("src/app/page.tsx"), /<time dateTime=\{readAt\}>\{readAt\}<\/time>/);
});

test("G1-001: same-host paste lists every returned listing and prompts for a full URL", () => {
  const paste = read("src/components/site/home/PasteCheck.tsx");
  assert.doesNotMatch(paste, /sameHostListings\.slice\(0, 3\)/);
  assert.match(paste, /to see a verdict for one listing/);
});

test("C1-004: no-record paste shows NONE verdict mark", () => {
  assert.match(read("src/components/site/home/PasteCheck.tsx"), /verdict="NONE"/);
  assert.match(read("src/app/home.module.css"), /\.pasteVerdictMarkNone/);
});
