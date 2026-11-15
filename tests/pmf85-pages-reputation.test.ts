import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  REPUTATION_FORBIDDEN_WORDS,
  reputationBodyLowercase,
  reputationDetailEligible,
  reputationForbiddenInBody,
  reputationPageEligible,
  selectReputationHosts,
} from "@/lib/sellers/reputation";
import { ReputationSellerArticle } from "@/app/x402/sellers/[host]/page";
import NotFound from "@/app/not-found";
import { buildSellerDetail, type SellerSummary } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";

const ROOT = process.cwd();

function summary(p: Partial<SellerSummary> & { host: string }): SellerSummary {
  return {
    host: p.host,
    listings: p.listings ?? 2,
    delivered: p.delivered ?? 2,
    pending: p.pending ?? 0,
    seller: p.seller ?? 0,
    vet402: p.vet402 ?? 0,
    unsorted: p.unsorted ?? 0,
    notPaid: p.notPaid ?? 0,
    notTried: p.notTried ?? 0,
    lastAttemptAt: p.lastAttemptAt ?? "2026-11-16T00:00:00Z",
    rebuyEligible: false,
    rebuyEndpointId: null,
  };
}

const delivered: SellerRowFacts = {
  endpointId: "e1",
  status: "settled",
  httpStatusPaid: 200,
  txHash: "0x" + "aa".repeat(32),
  attemptedAt: "2026-11-16T12:00:00Z",
  network: "eip155:8453",
  method: "GET",
  meta: null,
  schema: null,
  unpaidStatus: null,
  selection: null,
  verifyReason: null,
};

function eligibleDetail(host = "shop.example") {
  return buildSellerDetail(
    host,
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
  );
}

function htmlForbiddenCount(html: string): string[] {
  const lower = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const hits: string[] = [];
  for (const w of REPUTATION_FORBIDDEN_WORDS) {
    if (lower.includes(w)) hits.push(w);
  }
  return hits;
}

test("selectReputationHosts: delivered 1 と任意の非ゼロカウントで外れる", () => {
  const sellers = [
    summary({ host: "ok.example", delivered: 2 }),
    summary({ host: "one.example", delivered: 1 }),
    summary({ host: "seller-fail.example", delivered: 2, seller: 1 }),
    summary({ host: "vet402-fail.example", delivered: 2, vet402: 1 }),
    summary({ host: "unsorted.example", delivered: 2, unsorted: 1 }),
    summary({ host: "not-paid.example", delivered: 2, notPaid: 1 }),
    summary({ host: "pending.example", delivered: 2, pending: 1 }),
    summary({ host: "bad-host..", delivered: 2 }),
  ];
  assert.deepEqual(selectReputationHosts(sellers, 50), ["ok.example"]);
});

test("selectReputationHosts: delivered 降順、同数は host 昇順、limit", () => {
  const sellers = [
    summary({ host: "b.example", delivered: 3 }),
    summary({ host: "a.example", delivered: 3 }),
    summary({ host: "c.example", delivered: 5 }),
    summary({ host: "d.example", delivered: 4 }),
    summary({ host: "e.example", delivered: 4 }),
  ];
  assert.deepEqual(selectReputationHosts(sellers, 3), ["c.example", "d.example", "e.example"]);
  assert.deepEqual(selectReputationHosts(sellers, 10).slice(0, 2), ["c.example", "d.example"]);
});

test("reputationDetailEligible: 買った出品はすべて delivered、未購入は数に入れない", () => {
  const ok = eligibleDetail();
  assert.equal(reputationDetailEligible(ok), true);
  const partial = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered],
    "2026-11-16T12:00:00Z",
  );
  assert.equal(reputationDetailEligible(partial), false);

  const withNotTried = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
      { endpointId: "e3", resourceKey: "shop.example/new", resourceUrl: "https://shop.example/new", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
  );
  assert.equal(reputationDetailEligible(withNotTried), true);
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail: withNotTried }));
  assert.match(html, /At each of the 2 listings/);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/g)?.[0]?.match(/<tr>/g) ?? []).length, 2);
});

test("reputationDetailEligible: otherChain が新しく delivered に分類できない", () => {
  const d = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api", resourceUrl: "https://shop.example/api", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
    undefined,
    [{ endpointId: "e1", network: "eip155:56", status: "settle_failed", attemptedAt: "2026-11-17T00:00:00Z", httpStatusPaid: 500 }],
  );
  assert.equal(reputationDetailEligible(d), false);
});

test("reputationDetailEligible: withdrawnRoutes があると不適格", () => {
  const d = eligibleDetail();
  assert.equal(reputationDetailEligible({ ...d, withdrawnRoutes: [{ endpointId: "e1", resourceKey: "shop.example/x" }] }), false);
});

test("reputationDetailEligible: 対象外 host", () => {
  const d = eligibleDetail("Bad-Host");
  assert.equal(reputationDetailEligible(d), false);
});

test("reputationPageEligible: path に error があれば禁止語", () => {
  const d = buildSellerDetail(
    "shop.example",
    [
      { endpointId: "e1", resourceKey: "shop.example/api/error", resourceUrl: "https://shop.example/api/error", method: "GET", priceAmount: "1" },
      { endpointId: "e2", resourceKey: "shop.example/v1", resourceUrl: "https://shop.example/v1", method: "GET", priceAmount: "1" },
    ],
    [delivered, { ...delivered, endpointId: "e2", attemptedAt: "2026-11-16T11:00:00Z" }],
    "2026-11-16T12:00:00Z",
  );
  assert.equal(reputationDetailEligible(d), true);
  assert.equal(reputationForbiddenInBody(d), true);
  assert.equal(reputationPageEligible(d), false);
});

test("reputationBodyLowercase は reputationDetailEligible から呼べる", () => {
  const d = eligibleDetail();
  assert.ok(reputationBodyLowercase(d).includes("shop.example"));
});

test("評判ページ描画 HTML に禁止語が 0 件", () => {
  const detail = eligibleDetail();
  const html = renderToStaticMarkup(createElement(ReputationSellerArticle, { detail }));
  assert.deepEqual(htmlForbiddenCount(html), []);
  assert.match(html, /At each of the 2 listings/);
});

test("詳細が不適格なとき page は reputationPageEligible", () => {
  const src = readFileSync(join(ROOT, "src/app/x402/sellers/[host]/page.tsx"), "utf8");
  assert.match(src, /!detail \|\| !reputationPageEligible\(detail\)/);
  assert.doesNotMatch(src, /\bfailed\b/i);
});

test("対象外 host は reputation ルートで notFound", () => {
  const src = readFileSync(join(ROOT, "src/app/x402/sellers/[host]/page.tsx"), "utf8");
  assert.match(src, /getReputationHostsCached/);
  assert.match(src, /notFound\(\)/);
  assert.match(src, /!allowed\?\.includes\(host\)/);
});

test("404 本文に評判禁止語は無い", () => {
  const html = renderToStaticMarkup(createElement(NotFound));
  assert.deepEqual(htmlForbiddenCount(html), []);
});