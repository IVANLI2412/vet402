import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAttestPopulation,
  ERC8004_ATTEST_MAX_AGENTS,
  ERC8004_ATTEST_MAX_GAS_WEI,
  feedbackHashKeccak256,
  ledgerHasAgent,
  planAttestAgent,
  selectAttestTargets,
  sendRequiresEnabled,
  wouldExceedGasBudget,
  writerMustNotBePurchasePayer,
  ERC8004_ATTEST_MIN_SETTLED,
} from "@/lib/observatory/erc8004-attest";
import type { PurchaseFeedbackRow } from "@/lib/observatory/erc8004-feedback";
import type { Erc8004Match } from "@/lib/observatory/erc8004-match";
import { BASE_PAYER_PERIODS } from "@/lib/sellers/payers";

const ROW: PurchaseFeedbackRow = {
  id: "11111111-1111-4111-8111-111111111111",
  attempted_at: "2026-10-01T12:00:00.000Z",
  resource_key: "api.example.com/v1/x",
  network: "eip155:8453",
  status: "settled",
  amount_units: "1000",
  spent_units: "1000",
  tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  http_status_paid: 200,
  latency_ms: 120,
  l2_schema: "json",
  l2_detail: null,
  l2_body_head: '{"ok":true}',
  l2_content_type: "application/json",
  pay_to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  payer: "0xcccccccccccccccccccccccccccccccccccccccc",
  payload_non_empty: true,
  erc8004_agent: "eip155:8453:94639",
  erc8004_match_kind: "agent_wallet",
};

test("selectAttestTargets keeps agent_wallet only", () => {
  const matches: Erc8004Match[] = [
    { agentId: "1", chainId: "eip155:8453", payTo: "0xa", matchKind: "owner", purchases: 1, settled: 1 },
    { agentId: "2", chainId: "eip155:8453", payTo: "0xb", matchKind: "agent_wallet", purchases: 1, settled: 1 },
    { agentId: "2", chainId: "eip155:8453", payTo: "0xb", matchKind: "owner", purchases: 1, settled: 1 },
    { agentId: "3", chainId: "eip155:1", payTo: "0xc", matchKind: "agent_wallet", purchases: 1, settled: 1 },
  ];
  const t = selectAttestTargets(matches);
  assert.deepEqual(t.map((x) => x.agentId), ["2"]);
});

test("computeAttestPopulation excludes settled_4xx from denominator", () => {
  const rows = [
    ROW,
    { ...ROW, id: "2", http_status_paid: 404 },
    { ...ROW, id: "3", http_status_paid: 500, payload_non_empty: false },
  ];
  const pop = computeAttestPopulation(rows);
  assert.equal(pop.settled, 3);
  assert.equal(pop.inconclusiveSettled, 1);
  assert.equal(pop.delivered, 1);
  assert.equal(pop.judged, 2);
  assert.equal(pop.ratePercent, 50);
  assert.equal(pop.value, 5000n);
});

test("plan skips below min settled", () => {
  const match: Erc8004Match = {
    agentId: "94639",
    chainId: "eip155:8453",
    payTo: "0xb",
    matchKind: "agent_wallet",
    purchases: 2,
    settled: 2,
  };
  const r = planAttestAgent({
    match,
    week: "2026-W40",
    siteOrigin: "https://vet402.com",
    rows: [ROW, { ...ROW, id: "2" }],
    canonicalWeeklyBody: "{}",
  });
  assert.equal("skipReason" in r && r.skipReason, "min_settled");
  assert.equal(ERC8004_ATTEST_MIN_SETTLED, 3);
});

test("ledger prevents double write", () => {
  assert.equal(ledgerHasAgent({ week: "2026-W40", agents: [{ agentId: "1" }] }, "1"), true);
  assert.equal(ledgerHasAgent({ week: "2026-W40", agents: [{ agentId: "1" }] }, "2"), false);
});

test("writer must not be purchase payer", () => {
  const payer = BASE_PAYER_PERIODS[0]!.address;
  assert.equal(writerMustNotBePurchasePayer(payer), true);
  assert.equal(writerMustNotBePurchasePayer("0x0000000000000000000000000000000000000001"), false);
});

test("feedbackHash is keccak256 of utf8 body", () => {
  const body = '{"week":"2026-W40"}';
  const h = feedbackHashKeccak256(body);
  assert.match(h, /^0x[0-9a-f]{64}$/);
});

test("send requires ERC8004_ATTEST_ENABLED=1", () => {
  assert.equal(sendRequiresEnabled(false, undefined), true);
  assert.equal(sendRequiresEnabled(true, "1"), true);
  assert.equal(sendRequiresEnabled(true, "0"), false);
});

test("per-run caps are pinned", () => {
  assert.equal(ERC8004_ATTEST_MAX_AGENTS, 200);
  assert.equal(ERC8004_ATTEST_MAX_GAS_WEI, 500_000_000_000_000n);
});

test("gas budget stops when next tx exceeds remainder", () => {
  assert.equal(wouldExceedGasBudget(100n, 101n), true);
  assert.equal(wouldExceedGasBudget(100n, 100n), false);
});