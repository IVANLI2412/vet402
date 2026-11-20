import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE_FILES = [
  { path: "src/components/site/sellers/SellersViews.tsx", label: "/sellers" },
  { path: "src/app/observatory/state/page.tsx", label: "/observatory/state" },
  { path: "src/app/impact/page.tsx", label: "/impact" },
  { path: "src/app/observatory/methodology/page.tsx", label: "/observatory/methodology" },
] as const;

const RULES: { name: string; re: RegExp }[] = [
  { name: "we/our/us", re: /\b(we|our|us)\b/i },
  { name: "semicolon", re: /;/ },
  { name: "dash", re: /[\u2013\u2014]| - / },
  { name: ", not X", re: /,\s*not\b/i },
];

function violations(text: string): string[] {
  const t = text.trim();
  if (t === "—" || t === "–" || t === "-") return [];
  if (/^—\s*\(/.test(t)) return [];
  const normalized = text
    .replace(/&(?:apos|quot|lt|gt|amp);/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
  const out: string[] = [];
  for (const r of RULES) if (r.re.test(normalized)) out.push(r.name);
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const JSX_LINE =
  /className="(doc-|text-brand|fact-|sec-)|<\/?(p|td|th|li|h2|caption|strong|em)\b|^\s+[&A-Za-z].*</;

function literalProse(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"\\]|\\.)*"/g)) {
    const s = m[0]
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ");
    if (s.length >= 8 && /[a-zA-Z]/.test(s) && /\s/.test(s) && !s.includes("${") && !s.startsWith("/api")) out.push(s);
  }
  for (const m of line.matchAll(/'([^'\\]|\\.)*'/g)) {
    const s = m[0].slice(1, -1);
    if (s.length >= 8 && /[a-zA-Z]/.test(s) && /\s/.test(s)) out.push(s);
  }
  const gt = line.match(/>\s*([^<{]+?)\s*</);
  if (gt) {
    const s = gt[1].replace(/\s+/g, " ").trim();
    if (s.length >= 4 && /[a-zA-Z]/.test(s)) out.push(s);
  }
  return out;
}

/** 公開面 TSX の JSX 行から英文リテラルを拾う（コメントと TS 本体は除く）。 */
export function extractPublicProse(src: string): string[] {
  const stripped = stripComments(src);
  const anchor = stripped.search(/export (default|function Sellers|function Reading)/);
  const body = anchor >= 0 ? stripped.slice(anchor) : stripped;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (!JSX_LINE.test(line)) continue;
    if (/^\s*(import |const |let |type |interface |function [A-Z])/.test(line)) continue;
    out.push(...literalProse(line));
  }
  return out;
}

function assertNoViolations(fragments: readonly string[], label: string) {
  const problems: string[] = [];
  for (let i = 0; i < fragments.length; i++) {
    const v = violations(fragments[i]);
    if (v.length) problems.push(`${label} [#${i}] ${v.join(",")}: ${fragments[i].slice(0, 120)}`);
  }
  assert.deepEqual(problems, []);
}

test("規則そのものが当たる", () => {
  assert.ok(violations("We pay").includes("we/our/us"));
  assert.ok(violations("a; b").includes("semicolon"));
  assert.ok(violations("a \u2014 b").includes("dash"));
  assert.deepEqual(violations("—"), []);
  assert.deepEqual(violations("— (denominator)"), []);
});

for (const page of PAGE_FILES) {
  test(`${page.label} の公開英文（JSX 文字列）が MCP と同じ決まりを守る`, () => {
    const src = readFileSync(page.path, "utf8");
    const prose = extractPublicProse(src);
    assert.ok(prose.length >= 5, `${page.label}: prose fragments`);
    assertNoViolations(prose, page.label);
  });
}