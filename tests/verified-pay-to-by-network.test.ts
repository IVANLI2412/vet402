// ============================================================
// 2026-11-22: 判定の verified_pay_to_by_network（vet402 が払って配達を確かめた受取先を網ごとに）。
//
// 今までは SDK だけが payee_unverified_on_rail で断り、サーバの応答には「この網の payTo は未確認」が
// 出なかった（SDK を使わない呼び手には穴が見えない）。ここでは DB 無しの部分を固定する:
//  1. 純関数 verifiedPayToByNetworkOf: 複数網・同じ網で 2 つの payTo・XRPL 除外・空・正規化と重複・上限。
//  2. buildDecision: role=payer は欄を載せ（省略は []）、role=payee は常に []。
//  3. MCP check_x402_seller（= GET /api/v1/check の本体）: 同じ欄を写し、strict の出力 schema を通る。
//  4. 日次の公開判定（toPublicJudgment）にも同じ欄が残る。
// SQL（DISTINCT ON の問い合わせ）は loadSellerFacts の中で、DB の要る *.pg.test.ts の受け持ち。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERIFIED_PAY_TO_MAX, verifiedPayToByNetworkOf } from "@/lib/decision/seller-facts";
import { buildDecision, type DecisionResult, type DecisionSubject } from "@/lib/decision/decide";
import type { SellerFacts } from "@/lib/decision/types";
import { checkSeller, type McpDeps } from "@/lib/mcp/tools";
import { checkSellerOutput } from "@/lib/mcp/schemas";
import { toPublicJudgment } from "@/lib/judgments/public-judgment";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const SOL = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

test("verifiedPayToByNetworkOf: 複数網は網ごとに 1 行ずつ・新しい順・network は CAIP-2・EVM は小文字", () => {
  const out = verifiedPayToByNetworkOf([
    { tx_hash: "0x01", pay_to: A.toUpperCase().replace("0X", "0x"), network: "eip155:8453", attempted_at: "2026-11-20 10:00:00+00" },
    { tx_hash: "5Sig", pay_to: SOL, network: SOLANA, attempted_at: "2026-11-21 10:00:00+00" },
  ]);
  assert.deepEqual(out, [
    { network: SOLANA, pay_to: SOL, purchase_id: `${SOLANA}:5Sig`, verified_at: "2026-11-21T10:00:00.000Z" },
    { network: "eip155:8453", pay_to: A, purchase_id: "eip155:8453:0x01", verified_at: "2026-11-20T10:00:00.000Z" },
  ]);
});

test("verifiedPayToByNetworkOf: 同じ網で 2 つの payTo は 2 行（組ごとに数える）", () => {
  const out = verifiedPayToByNetworkOf([
    { tx_hash: "0x01", pay_to: A, network: "eip155:8453", attempted_at: "2026-11-20 10:00:00+00" },
    { tx_hash: "0x02", pay_to: B, network: "eip155:8453", attempted_at: "2026-11-19 10:00:00+00" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((v) => [v.network, v.pay_to]),
    [
      ["eip155:8453", A],
      ["eip155:8453", B],
    ],
  );
});

test("verifiedPayToByNetworkOf: XRPL は載せない（verified_terms と同じ理由）", () => {
  const out = verifiedPayToByNetworkOf([
    { tx_hash: "ABC", pay_to: "rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", network: "xrpl:0", attempted_at: "2026-11-21 10:00:00+00" },
    { tx_hash: "0x01", pay_to: A, network: "eip155:8453", attempted_at: "2026-11-20 10:00:00+00" },
  ]);
  assert.deepEqual(out.map((v) => v.network), ["eip155:8453"]);
});

test("verifiedPayToByNetworkOf: 行なし・欠けた列は空（確かめた受取先を作らない）", () => {
  assert.deepEqual(verifiedPayToByNetworkOf([]), []);
  const ok = { tx_hash: "0x01", pay_to: A, network: "eip155:8453", attempted_at: "2026-11-20 10:00:00+00" };
  for (const k of ["pay_to", "network", "attempted_at"] as const) {
    assert.deepEqual(verifiedPayToByNetworkOf([{ ...ok, [k]: null }]), [], k);
    assert.deepEqual(verifiedPayToByNetworkOf([{ ...ok, [k]: " " }]), [], k);
  }
  // tx の無い行（MPP など）は purchase_id だけ null で残す。
  assert.equal(verifiedPayToByNetworkOf([{ ...ok, tx_hash: null }])[0]?.purchase_id, null);
});

test("verifiedPayToByNetworkOf: 大文字小文字だけ違う EVM の受取先は 1 組・新しい方を残す。上限は 10", () => {
  const out = verifiedPayToByNetworkOf([
    { tx_hash: "0x01", pay_to: A, network: "eip155:8453", attempted_at: "2026-11-19 10:00:00+00" },
    { tx_hash: "0x02", pay_to: "0x" + "AA".repeat(20), network: "eip155:8453", attempted_at: "2026-11-20 10:00:00+00" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].purchase_id, "eip155:8453:0x02");
  const many = Array.from({ length: 15 }, (_, i) => ({
    tx_hash: `0x${i}`,
    pay_to: "0x" + i.toString(16).padStart(40, "0"),
    network: "eip155:8453",
    attempted_at: `2026-11-${String(i + 1).padStart(2, "0")} 00:00:00+00`,
  }));
  const capped = verifiedPayToByNetworkOf(many);
  assert.equal(capped.length, VERIFIED_PAY_TO_MAX);
  assert.equal(capped[0].verified_at, "2026-11-15T00:00:00.000Z", "新しい順");
});

const subject: DecisionSubject = {
  type: "resource",
  id: "r".repeat(64),
  endpoint_id: "e".repeat(64),
  observatory_id: "00000000-0000-0000-0000-000000000001",
  canonical_url: "https://api.example.org/x",
  method: "GET",
};
const facts: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-11-21T00:00:00Z", dialect: "v2", fail_reason: null },
  l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, n_inconclusive: 0, n_probe_error: 0, p50_ms: 1, p95_ms: 1, last_purchase_id: "eip155:8453:0x01", observed_at: "2026-11-20T10:00:00Z", last_attempt_at: "2026-11-20T10:00:00Z" },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: [`eip155:8453:${A}`],
  settlement_30d_real: 1,
  settlement_30d_raw: 1,
  settlement_30d_test: 0,
  settlement_30d_measurement: 0,
  unique_payers_30d_real: 1,
  wash_dominated: false,
};
const NOW = new Date("2026-11-22T00:00:00Z");
const BY_NETWORK = verifiedPayToByNetworkOf([
  { tx_hash: "0x01", pay_to: A, network: "eip155:8453", attempted_at: "2026-11-20 10:00:00+00" },
  { tx_hash: "5Sig", pay_to: SOL, network: SOLANA, attempted_at: "2026-11-19 10:00:00+00" },
]);

function payerDecision(withList: boolean): DecisionResult {
  return buildDecision({
    role: "payer",
    subject,
    facts,
    options: {},
    score: null,
    registry: { status: "off", tx_hash: null },
    ...(withList ? { verifiedPayToByNetwork: BY_NETWORK } : {}),
    now: NOW,
  });
}

test("buildDecision: role=payer は verified_pay_to_by_network を載せ（省略は []）、role=payee は常に []", () => {
  const withList = payerDecision(true);
  assert.deepEqual(withList.verified_pay_to_by_network, BY_NETWORK);
  const without = payerDecision(false);
  assert.ok("verified_pay_to_by_network" in without, "キーは常にある");
  assert.deepEqual(without.verified_pay_to_by_network, []);
  const payee = buildDecision({
    role: "payee",
    subject,
    payer: "eip155:8453:0x" + "33".repeat(20),
    facts: { settled_count_30d: 0, unique_payees_30d: 0, short_interval_payment_rate: 0, retry_burst_rate: 0, sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] }, erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null }, first_seen: null, last_seen: null },
    operatorBlacklist: false,
    registry: { status: "off", tx_hash: null },
    now: NOW,
  });
  assert.deepEqual(payee.verified_pay_to_by_network, []);
});

function deps(decision: DecisionResult | null): McpDeps {
  return {
    now: () => NOW,
    resolve: (async () =>
      decision
        ? { resource: { observatory_id: subject.observatory_id, canonical_url: subject.canonical_url, method: "GET" }, endpoints: [] }
        : { resource: null, endpoints: [] }) as unknown as McpDeps["resolve"],
    decide: (async () => decision) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps;
}

test("check_x402_seller（GET /api/v1/check の本体）: 判定の欄をそのまま写し、strict の出力 schema を通る", async () => {
  const out = await checkSeller(deps(payerDecision(true)), { url: subject.canonical_url });
  assert.deepEqual(out.verified_pay_to_by_network, BY_NETWORK);
  checkSellerOutput.parse(out);
  const notFound = await checkSeller(deps(null), { url: "https://unknown.example.org/x" });
  assert.equal(notFound.not_in_catalog, true);
  assert.deepEqual(notFound.verified_pay_to_by_network, []);
  checkSellerOutput.parse(notFound);
  // 判定の行に余計な鍵が混じっても、出力は 4 欄だけを写す（strict を破らない）。
  const dirty = payerDecision(true);
  dirty.verified_pay_to_by_network = BY_NETWORK.map((v) => ({ ...v, raw: "x" }) as typeof v);
  const cleaned = await checkSeller(deps(dirty), { url: subject.canonical_url });
  checkSellerOutput.parse(cleaned);
  assert.deepEqual(cleaned.verified_pay_to_by_network, BY_NETWORK);
});

test("toPublicJudgment: 日次の公開判定にも verified_pay_to_by_network が残る", () => {
  const out = toPublicJudgment(payerDecision(true), "2026-11-22");
  assert.deepEqual(out.verified_pay_to_by_network, BY_NETWORK);
});
