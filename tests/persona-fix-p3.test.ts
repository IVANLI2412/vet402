// Persona audit P3 work package (availability G2, usability G3-003, C5-006) — 2026-11-21.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainFreshness } from "@/lib/health/chain-freshness";
import {
  publicSettlementsIndexOf,
  settlementsIndexHeadline,
} from "@/lib/health/public-index-freshness";
import { assertPublicEnglishSurface } from "@/lib/v4/public-english";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function fakeRow(over: Partial<ChainFreshness> & Pick<ChainFreshness, "label" | "network">): ChainFreshness {
  return {
    lastIndexedAt: null,
    secondsBehind: null,
    expectedMsPerBlock: null,
    measuredMsPerBlock: null,
    interval: "unknown",
    note: null,
    ...over,
  };
}

test("G2: /status section 1 streams settlements index beside service status, not /api/health", () => {
  const status = read("src/app/status/page.tsx");
  assert.match(status, /CurrentIndexFreshness/);
  assert.match(status, /<Suspense[^>]*>[\s\S]*CurrentIndexFreshness/);
  assert.match(status, /A data lag is not an outage/);
  const health = read("src/app/api/health/route.ts");
  assert.doesNotMatch(health, /public-index-freshness/);
  assert.doesNotMatch(health, /settlementsIndex/);
  assert.match(health, /return NextResponse\.json\(\{ status \}, \{ status: httpStatus \}\);/);
});

test("G2: headline names lag from readChainFreshness fields only", () => {
  const summary = publicSettlementsIndexOf(
    [
      fakeRow({ label: "Base", network: "eip155:8453", secondsBehind: 5100 }),
      fakeRow({ label: "Solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", note: "not indexed yet" }),
    ],
    "2026-11-21T11:00:00.000Z",
  );
  const line = settlementsIndexHeadline(summary);
  assert.match(line, /Base 85 min behind/);
  assert.match(line, /Solana not indexed yet/);
  assertPublicEnglishSurface(line);
  assertPublicEnglishSurface("A data lag is not an outage, so it does not change the status above.");
});

test("G3-003: indexed hosts cross-link /sellers and /x402/sellers", () => {
  const sellers = read("src/app/sellers/[host]/page.tsx");
  assert.match(sellers, /reputationSellerPath/);
  assert.match(sellers, /indexed reputation page/);
  const rep = read("src/app/x402/sellers/[host]/page.tsx");
  assert.match(rep, /Full purchase record for/);
  assert.match(rep, /sellerPath\(host\)/);
});