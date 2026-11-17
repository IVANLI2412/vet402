import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildErc8004FeedbackDocument,
  buildWeeklySummary,
  deliveryOutcome,
  ERC8004_WEEKLY_PROOF_OF_PAYMENT_FROM_WEEK,
  isoWeekAtOrAfter,
  isoWeekUtcBounds,
  serializeFeedbackBody,
  sha256HexUtf8,
  ERC8004_FEEDBACK_SCHEMA,
} from "@/lib/observatory/erc8004-feedback";
import type { PurchaseFeedbackRow } from "@/lib/observatory/erc8004-feedback";
import { parseErc8004AgentCaip, erc8004AgentColumnSql } from "@/lib/observatory/erc8004-export-agent";

const BASE_ROW: PurchaseFeedbackRow = {
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

test("proofOfPayment.txHash equals export tx_hash", () => {
  const doc = buildErc8004FeedbackDocument(BASE_ROW, "2026-11-17T00:00:00.000Z");
  assert.ok(doc);
  assert.equal(doc!.proofOfPayment!.txHash, BASE_ROW.tx_hash);
});

test("settled_4xx is inconclusive_held and not negative delivery outcome", () => {
  const row = { ...BASE_ROW, http_status_paid: 400, status: "settled" };
  const d = deliveryOutcome(row);
  assert.equal(d.outcome, "inconclusive");
  assert.equal(d.inconclusive_held, true);
  assert.equal(d.held_reason, "settled_4xx");
});

test("contentSha256 matches canonical JSON body", () => {
  const doc = buildErc8004FeedbackDocument(BASE_ROW, "2026-11-17T00:00:00.000Z");
  assert.ok(doc);
  const { contentSha256, ...body } = doc!;
  const hash = sha256HexUtf8(serializeFeedbackBody(body));
  assert.equal(hash, contentSha256);
  assert.equal(body.version, ERC8004_FEEDBACK_SCHEMA);
});

const WEEKLY_KEY_ORDER = [
  "agentCaip",
  "methodology",
  "period",
  "population",
  "schema",
  "transactions",
  "week",
] as const;

test("weekly W46 body has no proofOfPayment (on-chain hash pinned)", () => {
  const summary = buildWeeklySummary({
    agentCaip: "eip155:8453:94639",
    week: "2026-W46",
    period: { from: "2026-11-09T00:00:00.000Z", to: "2026-11-16T00:00:00.000Z" },
    rows: [BASE_ROW],
    issuedAt: "2026-11-17T00:00:00.000Z",
  });
  const { contentSha256: _h, ...body } = summary;
  assert.deepEqual(Object.keys(body).sort(), [...WEEKLY_KEY_ORDER].sort());
  assert.equal("proofOfPayment" in body, false);
  assert.equal(isoWeekAtOrAfter("2026-W46", ERC8004_WEEKLY_PROOF_OF_PAYMENT_FROM_WEEK), false);
});

test("weekly W47 includes proofOfPayment from representative delivered row", () => {
  const late = {
    ...BASE_ROW,
    id: "33333333-3333-4333-8333-333333333333",
    attempted_at: "2026-11-20T12:00:00.000Z",
    tx_hash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    http_status_paid: 500,
    payload_non_empty: false,
  };
  const summary = buildWeeklySummary({
    agentCaip: "eip155:8453:94639",
    week: "2026-W47",
    period: { from: "2026-11-16T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" },
    rows: [late, BASE_ROW],
    issuedAt: "2026-11-18T00:00:00.000Z",
  });
  const { contentSha256: _h, proofOfPayment, ...body } = summary;
  assert.ok(proofOfPayment);
  assert.equal(proofOfPayment.txHash, BASE_ROW.tx_hash?.toLowerCase());
  assert.equal(summary.transactions[0]?.network, "eip155:8453");
  assert.equal(summary.transactions[1]?.network, "eip155:8453");
  assert.deepEqual(Object.keys(body).sort(), [...WEEKLY_KEY_ORDER].sort());
});

test("weekly W47 representative prefers delivered on agent chain", () => {
  const arbRow = {
    ...BASE_ROW,
    id: "44444444-4444-4444-8444-444444444444",
    attempted_at: "2026-11-17T10:00:00.000Z",
    network: "eip155:42161",
    tx_hash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  const baseLater = {
    ...BASE_ROW,
    id: "55555555-5555-4555-8555-555555555555",
    attempted_at: "2026-11-18T10:00:00.000Z",
    network: "eip155:8453",
  };
  const summary = buildWeeklySummary({
    agentCaip: "eip155:8453:94639",
    week: "2026-W47",
    period: { from: "2026-11-16T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" },
    rows: [arbRow, baseLater],
    issuedAt: "2026-11-19T00:00:00.000Z",
  });
  assert.equal(summary.proofOfPayment?.txHash, baseLater.tx_hash?.toLowerCase());
});

test("weekly summary counts delivered excluding inconclusive 4xx", () => {
  const rows = [
    BASE_ROW,
    { ...BASE_ROW, id: "22222222-2222-4222-8222-222222222222", http_status_paid: 404, status: "settled" },
  ];
  const week = buildWeeklySummary({
    agentCaip: "eip155:8453:94639",
    week: "2026-W40",
    period: { from: "2026-09-29T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
    rows,
    issuedAt: "2026-11-17T00:00:00.000Z",
  });
  assert.equal(week.population.purchases, 2);
  assert.equal(week.population.delivered, 1);
});

test("iso week bounds", () => {
  const b = isoWeekUtcBounds("2026-W40");
  assert.ok(b);
  assert.equal(b!.start.toISOString(), "2026-09-28T00:00:00.000Z");
});

test("erc8004_agent column SQL uses payTo only and valid alias", () => {
  assert.throws(() => erc8004AgentColumnSql("pu;drop"));
  const sql = erc8004AgentColumnSql("pu");
  assert.match(sql, /owner_agents/);
  assert.match(sql, /agents a/);
  assert.equal(parseErc8004AgentCaip("eip155:8453:94639")?.agentId, "94639");
  assert.equal(parseErc8004AgentCaip(""), null);
});