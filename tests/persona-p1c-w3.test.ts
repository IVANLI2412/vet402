// Persona audit P1 — work package W3 (UI, a11y, brand).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

test("home skip to paste link does not use RFC buttonClass", () => {
  const chrome = read("src/components/site/SiteChrome.tsx");
  const block = chrome.slice(chrome.indexOf("#lp-paste-url"), chrome.indexOf("Skip to the URL check") + 40);
  assert.doesNotMatch(block, /buttonClass/);
  const css = read("src/app/home.module.css");
  assert.match(css, /a\[href="#lp-paste-url"\]/);
});

test("home paste URL field stays at least 16px on narrow widths", () => {
  const css = read("src/app/home.module.css");
  const narrow = css.slice(css.indexOf("@media (max-width: 390px)"), css.indexOf("@media (max-width: 640px)"));
  assert.doesNotMatch(narrow, /\.pasteInput[\s\S]*font-size:\s*0\.8125rem/);
  assert.match(css, /\.pasteInput\s*\{[^}]*font-size:\s*1rem/);
});

test("docs F4 forecast note marks Japanese scope phrase with lang=ja", () => {
  const data = read("src/lib/docs/api-endpoints-data.tsx");
  assert.match(data, /lang="ja">名乗る買い手の場合<\/span>/);
});

test("PasteCheck announces Checking in the live region while loading", () => {
  const paste = read("src/components/site/home/PasteCheck.tsx");
  assert.match(paste, /phase === "loading" \?/);
  assert.match(paste, /data-testid="paste-live-loading"/);
  assert.match(paste, />\s*Checking\s*</);
});

test("observatory state loading streams with an h1", () => {
  const loading = read("src/app/observatory/state/loading.tsx");
  assert.match(loading, /pageTitle="State of x402"/);
  const skel = read("src/components/site/DocLoadingSkeleton.tsx");
  assert.match(skel, /<h1 id="doc-loading-title"/);
});

test("home LP bar links sit outside the default tab order", () => {
  const page = read("src/app/page.tsx");
  const header = page.slice(page.indexOf("<header className={s.wrap}>"), page.indexOf("</header>") + 10);
  assert.match(header, /tabIndex=\{-1\}/);
  assert.equal((header.match(/tabIndex=\{-1\}/g) ?? []).length, 3);
});