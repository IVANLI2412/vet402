import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { publicEnglishFaults } from "@/lib/diagnose/copy";
import {
  SellerErc8004SectionView,
  erc8004SectionLines,
  assertErc8004SectionCopySafe,
} from "@/components/site/sellers/SellerErc8004Section";
import type { SellerErc8004Binding } from "@/lib/sellers/erc8004-binding";

const READ_AT = "2026-11-18T00:00:00.000Z";
const WEEK = "2026-W46";

test("erc8004 section copy passes public English rules", () => {
  const ok: SellerErc8004Binding = {
    status: "ok",
    readAt: READ_AT,
    totalAgents: 1,
    agents: [
      {
        agentId: "7",
        payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        matchedBy: "wallet_confirmed",
        purchases: 2,
        settled: 1,
      },
    ],
  };
  const lines = erc8004SectionLines(ok, WEEK);
  assertErc8004SectionCopySafe(lines);
  for (const line of lines) {
    assert.deepEqual(publicEnglishFaults(line), [], line);
    assert.ok(!/\b(adoption|endorsement|trust score)\b/i.test(line), line);
  }
});

test("SellerErc8004SectionView renders nothing for status none", () => {
  const html = renderToStaticMarkup(
    createElement(SellerErc8004SectionView, { binding: { status: "none", readAt: READ_AT }, week: WEEK }),
  );
  assert.equal(html, "");
});

test("SellerErc8004SectionView shows a short notice when unavailable", () => {
  const html = renderToStaticMarkup(
    createElement(SellerErc8004SectionView, {
      binding: { status: "unavailable", reason: "query_failed", readAt: READ_AT },
      week: WEEK,
    }),
  );
  assert.match(html, /could not be read/i);
  assert.doesNotMatch(html, /purchase rows/);
});

test("SellerErc8004SectionView lists matched agents with weekly links and one check API pointer", () => {
  const html = renderToStaticMarkup(
    createElement(SellerErc8004SectionView, {
      binding: {
        status: "ok",
        readAt: READ_AT,
        totalAgents: 1,
        agents: [
          {
            agentId: "94639",
            payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            matchedBy: "owner_only",
            purchases: 3,
            settled: 2,
          },
        ],
      },
      week: WEEK,
    }),
  );
  assert.match(html, /Agent .*94639/);
  assert.match(html, /owner_only/);
  assert.doesNotMatch(html, /\/api\/v1\/erc8004\/check\?/, "the check API needs client and feedbackIndex, so no agent-only link");
    assert.match(html, /href="\/docs\/api"/);
  assert.match(html, /\/api\/v1\/observatory\/erc8004\/weekly\/94639\?week=2026-W46/);
  assert.match(html, /\/observatory\/methodology/);
});