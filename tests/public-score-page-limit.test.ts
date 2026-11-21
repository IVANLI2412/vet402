// whitehat-01: 採点頁は proxy の IP 枠を通る。scorePayeeWallet / scoreAgentById を載せる公開頁の一覧も固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

test("proxy wires public score pages through IP rate limit", () => {
  const proxy = readFileSync(join(ROOT, "src/proxy.ts"), "utf8");
  assert.ok(proxy.includes("isPublicScorePagePath"));
  assert.ok(proxy.includes("publicScoreRateLimitResponse"));
  assert.ok(proxy.includes("isSellersPath"));
});

test("leaderboard disables next/link prefetch on score destinations", () => {
  const page = readFileSync(join(ROOT, "src/app/leaderboard/page.tsx"), "utf8");
  assert.match(page, /prefetch=\{false\}/);
});

test("prefetch navigation is not counted against the public score limit", async () => {
  const { PUBLIC_SCORE_RL_LIMIT, publicScoreRateLimitResponse } = await import("@/lib/scoring/public-page-limit");
  for (let i = 0; i < PUBLIC_SCORE_RL_LIMIT + 20; i++) {
    const res = await publicScoreRateLimitResponse(
      new Request("http://localhost/payee/0x1234567890123456789012345678901234567890", {
        headers: { "next-router-prefetch": "1", "x-real-ip": "203.0.113.44" },
      }),
    );
    assert.equal(res, null, "prefetch must bypass the limit gate");
  }
  const normal = await publicScoreRateLimitResponse(
    new Request("http://localhost/payee/0x1234567890123456789012345678901234567890", {
      headers: { "x-real-ip": "203.0.113.44" },
    }),
  );
  assert.equal(normal, null, "after prefetches only, a normal request should still pass");
});

test("public score limit is 10 per minute", async () => {
  const { PUBLIC_SCORE_RL_LIMIT, PUBLIC_SCORE_RL_WINDOW_MS, isPublicScorePagePath } = await import(
    "@/lib/scoring/public-page-limit"
  );
  assert.equal(PUBLIC_SCORE_RL_LIMIT, 10);
  assert.equal(PUBLIC_SCORE_RL_WINDOW_MS, 60_000);
  assert.equal(isPublicScorePagePath("/payee/0x1234567890123456789012345678901234567890"), true);
  assert.equal(isPublicScorePagePath("/agent/1"), true);
  assert.equal(isPublicScorePagePath("/sellers/foo"), false);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("files importing scorePayeeWallet or scoreAgentById are API routes, lib, or rate-limited pages", () => {
  const proxy = readFileSync(join(ROOT, "src/proxy.ts"), "utf8");
  assert.ok(proxy.includes("publicScoreRateLimitResponse"), "proxy must rate-limit score pages");
  const srcFiles = walk(join(ROOT, "src"));
  const importers: string[] = [];
  for (const file of srcFiles) {
    const src = readFileSync(file, "utf8");
    if (!/\bimport\b[^;]*\b(scorePayeeWallet|scoreAgentById)\b/.test(src)) continue;
    importers.push(file.replace(ROOT + "/", ""));
  }
  for (const rel of importers) {
    const ok =
      rel.startsWith("src/lib/") ||
      rel.startsWith("src/app/api/") ||
      rel === "src/app/payee/[address]/page.tsx" ||
      rel === "src/app/agent/[agentId]/page.tsx" ||
      rel === "src/proxy.ts";
    assert.ok(ok, `${rel} imports the score engine but is not behind proxy or API limits`);
  }
});