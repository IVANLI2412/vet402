// PMF85 UX5 (FIX_UX5): placeholder 1024, methodology vocabulary defer, fix-first SSR shell, docs collapsible sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

test("home paste: URL field keeps 16px so iOS does not zoom on focus (persona C1-003)", () => {
  const css = read("src/app/home.module.css");
  assert.match(css, /\.pasteInput\s*\{[^}]*font-size:\s*1rem/);
  assert.doesNotMatch(css, /\.pasteInput\s*\{[^}]*0\.8125rem/);
  const narrow = css.slice(css.indexOf("@media (max-width: 390px)"), css.indexOf("@media (max-width: 640px)"));
  assert.doesNotMatch(narrow, /\.pasteInput/);
});

test("methodology §10: short JSON-LD stays; full OBSERVATORY_VOCABULARY loads on the client", () => {
  const page = read("src/app/observatory/methodology/page.tsx");
  assert.match(page, /vocabularyJsonLd\(SITE_URL, \{ short: true \}\)/);
  assert.match(page, /OBSERVATORY_VOCABULARY/);
  assert.match(page, /MethodologyVocabularyFold/);
  assert.doesNotMatch(page, /OBSERVATORY_VOCABULARY\.filter/);
  assert.match(read("src/components/observatory/MethodologyVocabularyFold.tsx"), /vocabulary-html/);
  assert.match(read("src/app/observatory/methodology/vocabulary-html/route.ts"), /methodologyVocabularyHtml/);
});

test("fix-first: SSR preview has h1 and fix-first-ssr anchor before client board", () => {
  const page = read("src/app/sellers/fix-first/page.tsx");
  assert.match(page, /FixFirstPreview/);
  const preview = read("src/components/site/sellers/FixFirstPreview.tsx");
  assert.match(preview, /id="fix-first-ssr"/);
  assert.match(preview, /fixFirstHeading/);
  assert.match(read("src/components/site/sellers/FixFirstBoardClient.tsx"), /fix-first-ssr/);
});

test("docs/api: deferred sections use DocBodySection; TOC opens details targets", () => {
  const rest = read("src/components/docs/ApiDocsRest.tsx");
  assert.match(rest, /import DocBodySection/);
  assert.ok((rest.match(/<DocBodySection/g) ?? []).length >= 10);
  assert.doesNotMatch(rest, /<section id=/);
  const endpoints = read("src/components/docs/ApiEndpointsSection.tsx");
  assert.match(endpoints, /DocBodySection/);
  const toc = read("src/components/docs/DocsToc.tsx");
  assert.match(toc, /openDocSectionFromHash/);
});