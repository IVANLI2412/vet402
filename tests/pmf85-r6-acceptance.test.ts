// PMF85 r6: reputation evidence age, pricing wording, signup lead, docs quickstart check-first, observatory pass probe age.
import { apiDocsPageText } from "./lib/api-docs-source";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  listingPathFromResourceKey,
  reputationHeadline,
  reputationHostEvidence,
  reputationSummarySentence,
} from "@/lib/sellers/reputation";
import { ReputationSellerArticle } from "@/app/x402/sellers/[host]/page";
import { buildSellerDetail } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";
import { KEYLESS_READ_STOP } from "@/lib/api/keyless-limits";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const deliveredAt = (iso: string): SellerRowFacts => ({
  endpointId: "e1",
  status: "settled",
  httpStatusPaid: 200,
  txHash: "0x" + "aa".repeat(32),
  attemptedAt: iso,
  network: "eip155:8453",
  method: "GET",
  meta: null,
  schema: null,
  unpaidStatus: null,
  selection: null,
  verifyReason: null,
});

function twoListingDetail(host: string, isoA: string, isoB: string, fetchedAt: string) {
  return buildSellerDetail(
    host,
    [
      { endpointId: "e1", resourceKey: `${host}/api`, resourceUrl: `https://${host}/api`, method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: `${host}/v1`, resourceUrl: `https://${host}/v1`, method: "GET", priceAmount: "1" },
    ],
    [deliveredAt(isoA), { ...deliveredAt(isoB), endpointId: "e2" }],
    fetchedAt,
  );
}

test("listingPathFromResourceKey does not emit a double slash", () => {
  assert.equal(listingPathFromResourceKey("shop.example/api", "shop.example"), "/api");
  assert.doesNotMatch(listingPathFromResourceKey("shop.example/api/x", "shop.example"), /\/\//);
});

test("fresh seller reputation page shows days ago without stale", () => {
  const detail = twoListingDetail("shop.example", "2026-11-15T12:00:00Z", "2026-11-14T11:00:00Z", "2026-11-16T12:00:00Z");
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail }));
  assert.match(html, /last delivered 1 days ago/);
  assert.doesNotMatch(html, /> \(stale\)</);
  assert.match(html, /<h1[^>]*>Does shop\.example deliver\?<\/h1>/);
  assert.doesNotMatch(html, /WARN/);
});

test("stale seller reputation H1 and rows match check WARN", () => {
  const detail = twoListingDetail("stale.example", "2026-08-15T00:00:00Z", "2026-08-14T00:00:00Z", "2026-11-16T12:00:00Z");
  const evidence = reputationHostEvidence(detail);
  assert.equal(evidence.tier, "stale");
  assert.equal(evidence.max_recommendation, "WARN");
  assert.equal(
    reputationHeadline("stale.example", detail),
    "Does stale.example still deliver? Latest delivery is older than 30 days",
  );
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail }));
  assert.match(html, /Latest delivery is older than 30 days/);
  assert.doesNotMatch(html, /Does stale\.example deliver\? WARN/);
  assert.match(html, /last delivered 93\.5 days ago/);
  assert.equal((html.match(/\(stale\)/g) ?? []).length, 2);
  assert.match(html, /check answer for this host is WARN/);
  assert.match(reputationSummarySentence(detail), /delivered a response 93\.5 days ago/);
});

test("PricingSection drops Usage-based for monthly quota wording", async () => {
  const { PricingSection } = await import("@/components/site/PricingSection");
  const html = renderToStaticMarkup(PricingSection({ titleId: "r6-pricing" }));
  assert.match(html, /Monthly plans with a score lookup quota/);
  assert.doesNotMatch(html, /Usage-based/);
});

test("Usage-based is gone from src", () => {
  const pricing = read("src/components/site/PricingSection.tsx");
  assert.doesNotMatch(pricing, /Usage-based/);
});

test("signup H1 leads with benefit and links methodology", () => {
  const signup = read("src/app/signup/page.tsx");
  assert.match(signup, /A free API key adds score lookups for your agent\. Seller checks need no key\./);
  assert.match(signup, /href="\/observatory\/methodology"/);
  assert.doesNotMatch(signup, /A free key reads a payee score/);
});

test("docs/api quickstart leads with GET /api/v1/check and keeps KEYLESS_READ_STOP after it", () => {
  const docs = apiDocsPageText();
  const qs = docs.indexOf('id="quickstart"');
  const resolve = docs.indexOf("/api/v1/resolve?q=https://api.exa.ai/search", qs);
  const check = docs.indexOf("/api/v1/check?url=", qs);
  assert.ok(check > qs && resolve > check, "check quickstart before resolve");
  const checkBlock = docs.slice(check, check + 1200);
  assert.match(checkBlock, /GET \/api\/v1\/check\?url=/);
  assert.match(checkBlock, /\{KEYLESS_READ_STOP\}/);
  assert.equal(KEYLESS_READ_STOP, "Keyless reads of /decision can be paused by the operator.");
  const intro = docs.slice(docs.indexOf("{API_DOCS_ANSWER}"), qs);
  assert.doesNotMatch(intro, /KEYLESS_READ_STOP/);
});

test("observatory pass caption splits active pass probes within 7 days vs older", () => {
  const obs = read("src/app/observatory/page.tsx");
  assert.match(obs, /publishedPassActiveProbeOlderThan7d/);
  assert.match(obs, /last probed within 7 days/);
  assert.match(obs, /passProbedWithin7d/);
});