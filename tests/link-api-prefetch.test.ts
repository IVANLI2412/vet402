import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTsx(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function badLinkHrefs(src: string): string[] {
  const hits: string[] = [];
  const re = /<Link[^>]*\bhref=\{?(`[^`]+`|["'][^"']+["'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const href = m[1].replace(/^["']|["']$/g, "").replace(/^`|`$/g, "");
    if (href.startsWith("/api/") || href.includes("/api/") || href.endsWith(".csv") || href.endsWith(".json"))
      hits.push(href);
  }
  return hits;
}

test("next/link must not target /api/ paths or .csv/.json downloads", () => {
  const root = join(process.cwd(), "src");
  const violations: string[] = [];
  /** Frozen with origin/main (tests/seo-audit-1026.test.ts); still uses Link until that freeze lifts. */
  const skip = new Set(["src/app/rwa/[address]/page.tsx"]);
  for (const file of walkTsx(root)) {
    const rel = file.slice(process.cwd().length + 1);
    if (skip.has(rel)) continue;
    const bad = badLinkHrefs(readFileSync(file, "utf8"));
    if (bad.length) violations.push(`${rel}: ${bad.join(", ")}`);
  }
  assert.deepEqual(violations, []);
});