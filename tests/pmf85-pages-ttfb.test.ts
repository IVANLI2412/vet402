import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { playgroundProbeEndpointId } from "@/app/playground/probe-endpoint";
import { chainFreshnessFromCache, chainFreshnessToCache } from "@/lib/health/status-cached-reads";
import type { ChainFreshness } from "@/lib/health/chain-freshness";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const UNCACHED_CALLS = [
  "getObservatoryOverview(",
  "getCoverageShare(",
  "getDecisionFeed(",
  "computeSpendGuardBacktest(",
  "getStatusHistory(",
  "readChainFreshness(",
];

const CACHED_EXPECTED: [string, string[]][] = [
  ["src/app/decisions/page.tsx", ["getDecisionFeed30Cached", "getSpendGuardBacktestCached"]],
];

const STATUS_DYNAMIC: [string, string[]][] = [
  ["src/app/status/page.tsx", ["getStatusHistory(", "readChainFreshness("]],
];

test("decisions は重い関数を直接 await せずキャッシュ版を使う", () => {
  for (const [file, cached] of CACHED_EXPECTED) {
    const src = read(file);
    for (const bad of UNCACHED_CALLS) {
      assert.equal(src.includes(bad), false, `${file} still calls ${bad}`);
    }
    for (const sym of cached) {
      assert.ok(src.includes(sym), `${file} missing ${sym}`);
    }
  }
});

test("/status はリクエスト時に history と chain freshness を直接読む", () => {
  for (const [file, required] of STATUS_DYNAMIC) {
    const src = read(file);
    assert.match(src, /export const dynamic = "force-dynamic"/);
    assert.equal(src.includes("getStatusHistoryCached"), false);
    assert.equal(src.includes("getChainFreshnessCached"), false);
    for (const sym of required) {
      assert.ok(src.includes(sym), `${file} missing ${sym}`);
    }
  }
});

test("playground の page は描画中に observatory の重い読みを await しない", () => {
  const page = read("src/app/playground/page.tsx");
  const client = read("src/app/playground/playground-client.tsx");
  for (const sym of ["getObservatoryOverviewCached", "getCoverageShareCached", "getObservatoryOverview(", "getCoverageShare("]) {
    assert.equal(page.includes(sym), false, `playground page still mentions ${sym}`);
  }
  assert.match(client, /loadPlaygroundCatalog/);
  assert.match(read("src/app/playground/load-catalog.ts"), /getObservatoryOverviewCached/);
});

test("playground 初回 Run は ensureCatalog の先頭 id（state を待たない）", () => {
  const cands = [{ id: "a", resourceKey: "h/a", network: null, method: "GET" }];
  assert.equal(playgroundProbeEndpointId(false, "", [], cands), "a");
  assert.equal(playgroundProbeEndpointId(true, "b", [{ id: "b", resourceKey: "h/b", network: null, method: null }], cands), "b");
  assert.equal(playgroundProbeEndpointId(true, "", [{ id: "b", resourceKey: "h/b", network: null, method: null }], cands), "b");
});

test("status チェーン鮮度キャッシュは JSON 往復後も Date で fmt できる", () => {
  const iso = "2026-11-16T08:00:00.000Z";
  const rows: ChainFreshness[] = [
    {
      network: "eip155:8453",
      label: "Base",
      lastIndexedAt: new Date(iso),
      secondsBehind: 1,
      interval: "ok",
      note: null,
      expectedMsPerBlock: 200,
      measuredMsPerBlock: 200,
    },
  ];
  const cached = chainFreshnessToCache(rows);
  const round = JSON.parse(JSON.stringify(cached)) as typeof cached;
  const restored = chainFreshnessFromCache(round);
  assert.equal(restored[0]!.lastIndexedAt!.toISOString(), iso);
});