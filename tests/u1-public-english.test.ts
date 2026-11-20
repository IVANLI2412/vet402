import { apiDocsPageText } from "./lib/api-docs-source";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIND_RULE } from "@/lib/find/find-handler";

const BANNED = /\b(we|our|us)\b|—|–/i;
const SEMICOLON = /;/;

function assertPublicEnglish(label: string, text: string, forbidSemicolon = false) {
  assert.doesNotMatch(text, BANNED, `${label}: banned wording or dash`);
  if (forbidSemicolon) assert.doesNotMatch(text, SEMICOLON, `${label}: semicolon in prose`);
}

test("FIND_RULE public English", () => {
  assertPublicEnglish("FIND_RULE", FIND_RULE, true);
});

test("methodology find-ranking paragraph", () => {
  const page = readFileSync("src/app/observatory/methodology/page.tsx", "utf8");
  const m = page.match(/id="find-ranking"[\s\S]*?<p className="doc-p">([\s\S]*?)<\/p>/);
  assert.ok(m, "find-ranking paragraph");
  const plain = m![1]!
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assertPublicEnglish("methodology find-ranking", plain, true);
  assert.match(plain, /catalog rows carry no tags/);
});

test("CHANGELOG U1 section", () => {
  const log = readFileSync("docs/handoffs/CHANGELOG.md", "utf8");
  const m = log.match(/## 2026-11-15 U1:[\s\S]*?(?=\n## |$)/);
  assert.ok(m, "U1 CHANGELOG entry");
  assertPublicEnglish("CHANGELOG U1", m![0]!, true);
});

test("openapi find description and docs find card", () => {
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  const findBlock = openapi.match(/\/api\/v1\/find:[\s\S]*?(?=\n  \/)/);
  assert.ok(findBlock, "find path in openapi");
  assertPublicEnglish("openapi find", findBlock![0]!, true);
  const docs = apiDocsPageText();
  const card = docs.match(/path: "\/api\/v1\/find[\s\S]*?response: `[^`]+`/);
  assert.ok(card, "find card in docs api");
  assertPublicEnglish("docs find card", card![0]!, true);
});

test("PasteCheck source has no em dash", () => {
  const src = readFileSync("src/components/site/home/PasteCheck.tsx", "utf8");
  assert.doesNotMatch(src, /—|–/, "PasteCheck source");
});