// ============================================================
// XRPL の支払い付き要求だけ 45 秒（2026-11-16）。
// 無払いの要求と、ほかのチェーンの支払い付き要求は 20 秒のまま。
// Run: npx tsx --test tests/l1-xrpl-paid-timeout.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { XRPL_MAINNET_CAIP2 } from "@/lib/observatory/chains";
import {
  L1_REQUEST_TIMEOUT_MS,
  L1_XRPL_NETWORK,
  L1_XRPL_PAID_TIMEOUT_MS,
  L1_XRPL_PAID_TIMEOUT_SINCE,
  l1PaidTimeoutMs,
} from "@/lib/observatory/l1-timing";
import {
  L1_BATCH_BUDGET_MS,
  L1_PURCHASE_SLACK_MS,
  canStartAnotherPurchase,
  paidTimeoutForBudget,
  worstCasePurchaseMs,
} from "@/lib/observatory/l1-runner";

test("支払い付きの待ちは XRPL mainnet だけ 45 秒。testnet とほかのチェーンは 20 秒", () => {
  assert.equal(L1_XRPL_NETWORK, XRPL_MAINNET_CAIP2);
  assert.equal(L1_XRPL_PAID_TIMEOUT_MS, 45_000);
  assert.equal(l1PaidTimeoutMs("xrpl:0"), 45_000);
  assert.equal(l1PaidTimeoutMs("xrpl:1"), 20_000, "XRPL Testnet is not the payment lane");
  assert.equal(l1PaidTimeoutMs("xrpl:2"), 20_000);
  assert.equal(l1PaidTimeoutMs("xrpl:0 "), 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:8453"), 20_000);
  assert.equal(l1PaidTimeoutMs("eip155:42220"), 45_000, "Celo unchanged");
  assert.equal(l1PaidTimeoutMs(null), 20_000);
  assert.equal(l1PaidTimeoutMs("xrpl:0", { timeoutMs: 20_000, xrplPaidTimeoutMs: 45_000 }), 45_000);
  assert.equal(l1PaidTimeoutMs("eip155:8453", { timeoutMs: 20_000, xrplPaidTimeoutMs: 45_000 }), 20_000);
  assert.equal(l1PaidTimeoutMs("xrpl:0", { timeoutMs: 30, xrplPaidTimeoutMs: 80 }), 80);
});

test("無払いの待ちは XRPL も既定の 20 秒（l1PaidTimeoutMs は支払い付きだけ）", () => {
  assert.equal(L1_REQUEST_TIMEOUT_MS, 20_000);
});

test("予算: XRPL レーンは支払い付き 45 秒を見込み、バッチ予算との和は maxDuration 300 秒の内側", () => {
  const basePaid = paidTimeoutForBudget({ network: "eip155:8453", laneChain: null }, L1_REQUEST_TIMEOUT_MS);
  const xrplPaid = paidTimeoutForBudget({ network: "eip155:8453", laneChain: "xrpl" }, L1_REQUEST_TIMEOUT_MS);
  const xrplPrimary = paidTimeoutForBudget({ network: "xrpl:0", laneChain: null }, L1_REQUEST_TIMEOUT_MS);
  assert.equal(basePaid, 20_000);
  assert.equal(xrplPaid, 45_000);
  assert.equal(xrplPrimary, 45_000);
  const xrplWorst = worstCasePurchaseMs(L1_REQUEST_TIMEOUT_MS, xrplPaid);
  assert.equal(xrplWorst, 20_000 + 45_000 + L1_PURCHASE_SLACK_MS);
  assert.equal(canStartAnotherPurchase(xrplWorst, L1_REQUEST_TIMEOUT_MS, xrplPaid), true);
  assert.ok(L1_BATCH_BUDGET_MS + xrplWorst <= 300_000);
});

test("方法論の since は l1-timing の定数。頁に日付のリテラルを書かない", () => {
  assert.equal(L1_XRPL_PAID_TIMEOUT_SINCE, "2026-11-16");
  const page = readFileSync(join(process.cwd(), "src/app/observatory/methodology/page.tsx"), "utf8");
  assert.match(page, /L1_XRPL_PAID_TIMEOUT_SINCE/);
  assert.equal(page.includes("since 2026-11-16"), false);
  const timing = readFileSync(join(process.cwd(), "src/lib/observatory/l1-timing.ts"), "utf8");
  assert.match(timing, /L1_XRPL_PAID_TIMEOUT_SINCE = "2026-11-16"/);
});