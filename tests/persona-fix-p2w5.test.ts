// Persona audit P2 work package W5 (availability, branding) — 2026-11-21.
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

test("G2 availability: /status section 1 streams settlements index beside service status", () => {
  const status = read("src/app/status/page.tsx");
  assert.match(status, /CurrentIndexFreshness/);
  assert.match(status, /<Suspense[^>]*>[\s\S]*CurrentIndexFreshness/);
});

test("G2 availability: shallow /api/health may attach settlementsIndex next to status", () => {
  const health = read("src/app/api/health/route.ts");
  assert.match(health, /readPublicSettlementsIndex/);
  assert.match(health, /settlementsIndex/);
  assert.match(read("docs/openapi.yaml"), /PublicSettlementsIndex/);
});

test("G2 availability: headline names lag from public chain fields only", () => {
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
});

test("C1-005: home four-count read time matches sparkline UTC phrasing", () => {
  assert.match(
    read("src/app/page.tsx"),
    /<time dateTime=\{readAt\}>[\s\S]*\{ledger\.readDate\} \{ledger\.readTime\} UTC/,
  );
});

test("C1-006: check-a-seller explains monochrome paste on RFC page", () => {
  const page = read("src/app/x402/check-a-seller/page.tsx");
  assert.match(page, /monochrome paste form/);
  assert.match(page, /navy RFC/);
  assertPublicEnglishSurface(
    "The URL check below uses the same monochrome paste form as the home page, not the navy RFC paper chrome on this page header.",
  );
});