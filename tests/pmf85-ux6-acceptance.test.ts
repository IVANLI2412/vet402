// PMF85 UX6 (FIX_UX6): sellers, observatory, playground, verdict marks, site events, sparkline, calendar, motion, DESIGN signup, RFC dark nav.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

test("P1-2: /sellers placeholder and chain nav", () => {
  const v = read("src/components/site/sellers/SellersViews.tsx");
  assert.match(v, /placeholder="llm\.gedx402\.com"/);
  assert.match(v, /All chains \(Observatory\)/);
  assert.match(read("src/components/site/sellers/SellerCalledVsDeliveredSection.tsx"), /primary figures/);
});

test("P1-3: observatory network select and shorter default caption", () => {
  const obs = read("src/app/observatory/page.tsx");
  assert.match(obs, /<select[^>]*name="network"/);
  assert.match(read("src/lib/observatory/network-filter-options.ts"), /All chains/);
  assert.doesNotMatch(obs, /placeholder="eip155:8453"/);
  assert.match(obs, /Definitions:/);
});

test("P1-5: playground loads catalog on open and labels probe as no payment", () => {
  const client = read("src/app/playground/playground-client.tsx");
  assert.match(client, /useEffect\(\(\) => \{[\s\S]*loadPlaygroundCatalog/);
  assert.match(client, /Probe this payment wall \(L0, no payment\)/);
  assert.match(client, /does not pay anyone/);
  const page = read("src/app/playground/page.tsx");
  assert.match(page, /Candidates load when you open this page/);
});

test("P1-6: 16px verdict marks and code wrap", () => {
  assert.match(read("src/components/site/Figures.tsx"), /size = 16/);
  assert.match(read("src/components/site/VerdictBadge.tsx"), /VerdictShapeMark/);
  const css = read("src/app/home.module.css");
  assert.match(css, /\.pasteVerdictMarkAllow[\s\S]*width: 16px/);
  assert.match(css, /\.pasteCode pre[\s\S]*white-space: pre-wrap/);
});

test("P1-7: home funnel events in allowlist", () => {
  const ev = read("src/lib/site-events.ts");
  for (const name of [
    "home_paste_invalid",
    "home_paste_error",
    "home_verdict",
    "home_cta",
    "nav_check_click",
    "mcp_docs_first_prompt_copy",
  ]) {
    assert.match(ev, new RegExp(`"${name}"`));
  }
  assert.match(read("src/components/site/SiteHeader.tsx"), /nav_check_click/);
});

test("P2-1: home sparkline from daily metrics", () => {
  assert.match(read("src/components/site/home/HomePurchaseSparkline.tsx"), /getDailyMetricsHistory/);
  assert.match(read("src/app/page.tsx"), /HomePurchaseSparkline/);
});

test("P2-2: seller delivery calendar", () => {
  assert.match(read("src/lib/sellers/delivery-calendar.ts"), /buildDeliveryCalendar/);
  assert.match(read("src/app/sellers/[host]/page.tsx"), /SellerDeliveryCalendar/);
});

test("P2-3: dither and paste card rise", () => {
  const css = read("src/app/home.module.css");
  assert.match(css, /radial-gradient\(circle at 1px 1px/);
  assert.match(css, /\.pasteResultRise/);
  assert.match(css, /translateY\(6px\)/);
});

test("P2-5: DESIGN.md documents /signup world", () => {
  assert.match(read("DESIGN.md"), /## Signup \(`\/signup`\)/);
});

test("P2-6: RFC header dark contrast tweak", () => {
  assert.match(read("src/app/globals.css"), /@media \(prefers-color-scheme: dark\)[\s\S]*\.site-header/);
});