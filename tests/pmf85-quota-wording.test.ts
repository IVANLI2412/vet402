// PMF85 r3: monthly BILLING_PLANS limits are score lookups, not seller checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PUBLIC_QUOTA_SURFACES = [
  "src/app/page.tsx",
  "src/app/pricing/page.tsx",
  "src/app/signup/page.tsx",
  "src/app/signup/layout.tsx",
  "src/app/docs/api/page.tsx",
  "src/components/site/PricingSection.tsx",
] as const;

const FORBIDDEN_QUOTA_PHRASES = [
  /seller checks?\s*\/\s*month/i,
  /seller checks a month/i,
  /\d{1,3}(?:,\d{3})+\s+seller checks/i,
  /monthly seller check quota/i,
  /monthlyLimit[\s\S]{0,80}seller checks?/i,
  /seller checks?[\s\S]{0,80}monthlyLimit/i,
  /description:\s*`\$\{BILLING_PLANS\.[^`]+seller checks/i,
];

function forbiddenQuotaPhrases(src: string, file: string): string[] {
  const bad: string[] = [];
  for (const line of src.split("\n")) {
    for (const re of FORBIDDEN_QUOTA_PHRASES) {
      if (re.test(line)) {
        bad.push(`${file}: ${line.trim()}`);
      }
    }
  }
  return bad;
}

test("monthly quota surfaces do not pair seller checks with plan limits", () => {
  const violations: string[] = [];
  for (const f of PUBLIC_QUOTA_SURFACES) {
    violations.push(...forbiddenQuotaPhrases(read(f), f));
  }
  assert.equal(violations.length, 0, violations.join("\n"));
});

test("PricingSection states seller checks are keyless and unmetered", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PricingSection } = await import("@/components/site/PricingSection");
  const html = renderToStaticMarkup(PricingSection({ titleId: "quota-wording" }));
  assert.match(html, /Seller checks.*\/api\/v1\/check.*need no key and do not count against the monthly quota/);
  assert.match(html, />Score lookups \/ month</);
  assert.doesNotMatch(html, /seller checks? \/ month/i);
  assert.doesNotMatch(html, /1,000 seller checks/i);
});