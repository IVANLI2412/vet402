import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const RULES: { name: string; re: RegExp }[] = [
  { name: "we/our/us", re: /\b(we|our|us)\b/i },
  { name: "semicolon", re: /;/ },
  { name: "dash", re: /[\u2013\u2014]| - / },
  { name: ", not X", re: /,\s*not\b/i },
];

function violations(text: string): string[] {
  const normalized = text.replace(/&(?:apos|quot|lt|gt|amp);/g, " ");
  const out: string[] = [];
  for (const r of RULES) if (r.re.test(normalized)) out.push(r.name);
  return out;
}

function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const next = src.indexOf("\nfunction ", start + 1);
  return next >= 0 ? src.slice(start, next) : src.slice(start);
}

test("/sellers 公開文（一覧のリード・How to read）が MCP と同じ英文の決まりを守る", () => {
  const src = readFileSync("src/components/site/sellers/SellersViews.tsx", "utf8");
  const lead = src.match(
    /\{n\(t\.sellers\)\} sellers with[\s\S]*?groups the failures by kind\./,
  );
  assert.ok(lead, "sellers index lead paragraph");
  const leadProse = lead[0].replace(/\{[^}]+\}/g, " ");
  assert.deepEqual(violations(leadProse), [], leadProse.slice(0, 120));

  const notes = sliceFunction(src, "ReadingNotes");
  const doc = notes.match(/<p className="doc-p">([\s\S]*?)<\/p>/);
  assert.ok(doc, "ReadingNotes doc-p");
  const notesProse = doc[1].replace(/\{[^}]+\}/g, " ").replace(/<[^>]+>/g, " ");
  assert.deepEqual(violations(notesProse), [], "ReadingNotes");
});

test("/observatory/state の L1 表ラベル（C-3 で直した行）が英文の決まりを守る", () => {
  const src = readFileSync("src/app/observatory/state/page.tsx", "utf8");
  const rows = [
    "settled where the seller returned no receipt and vet402&apos;s own settlements index found the",
    "while vet402&apos;s Base payer wallet was out",
    "count these as a malformed request",
  ];
  for (const needle of rows) {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, needle);
    const open = src.lastIndexOf('<td className="text-brand">', i);
    const close = src.indexOf("</td>", i);
    let block = src.slice(open, close);
    block = block.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const textOnly = block.replace(/<[^>]+>/g, " ");
    assert.deepEqual(violations(textOnly), [], textOnly.slice(0, 120));
  }
});