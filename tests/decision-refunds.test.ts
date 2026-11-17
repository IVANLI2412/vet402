import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDecision, type DecisionSubject } from "@/lib/decision/decide";
import {
  SELLER_REFUNDED_FAILURES,
  attachSellerRefundsToDecision,
  shouldEmitSellerRefundedFailures,
  sumHostRefunds,
  type DecisionHostRefunds,
} from "@/lib/decision/seller-refunds";
import type { RefundStats } from "@/lib/sellers/refunds";
import type { SellerFacts } from "@/lib/decision/types";

const SUBJECT: DecisionSubject = {
  type: "resource",
  id: "r".repeat(64),
  endpoint_id: "e".repeat(64),
  observatory_id: "00000000-0000-0000-0000-000000000001",
  canonical_url: "https://refund-host.example/path",
  method: "GET",
};

const SELLER: SellerFacts = {
  l0: { status: "pass", observed_at: "2026-11-01T00:00:00.000Z", dialect: "v2", fail_reason: null },
  l1: {
    n_delivered: 1,
    n_settled: 1,
    n_attempts: 1,
    n_inconclusive: 0,
    n_probe_error: 0,
    p50_ms: 1,
    p95_ms: 1,
    last_purchase_id: null,
    observed_at: "2026-11-01T00:00:00.000Z",
    last_attempt_at: "2026-11-01T00:00:00.000Z",
  },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: [],
  settlement_30d_real: 0,
  settlement_30d_raw: 0,
  settlement_30d_test: 0,
  settlement_30d_measurement: 0,
  unique_payers_30d_real: 0,
  wash_dominated: false,
};

function baseDecision() {
  return buildDecision({
    role: "payer",
    subject: SUBJECT,
    facts: SELLER,
    options: {},
    score: null,
    registry: { status: "off", tx_hash: null },
  });
}

const SAMPLE_STATS: RefundStats = {
  pay_tos: [
    {
      pay_to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      listings_sharing: 1,
      failures_counted: 1,
      paid_units: "1000",
      refunded_units: "500",
      refunded_units_raw: "500",
      refund_rate: 0.5,
      refund_transfers: 1,
      refund_txs: [],
      failures_window_open: 0,
    },
    {
      pay_to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      listings_sharing: 1,
      failures_counted: 1,
      paid_units: "1000",
      refunded_units: "490",
      refunded_units_raw: "490",
      refund_rate: 0.49,
      refund_transfers: 1,
      refund_txs: [],
      failures_window_open: 0,
    },
  ],
  window_days: 30,
  networks_read: ["eip155:8453"],
  read_through: "2026-12-01T00:00:00.000Z",
  failures_not_read: 0,
};

test("sumHostRefunds sums payTos", () => {
  const r = sumHostRefunds(SAMPLE_STATS);
  assert.equal(r.failures_counted, 2);
  assert.equal(r.paid_units, "2000");
  assert.equal(r.refunded_units, "990");
  assert.equal(r.refund_rate, 0.495);
  assert.equal(r.window_days, 30);
});

test("shouldEmitSellerRefundedFailures threshold", () => {
  const none: DecisionHostRefunds = { ...sumHostRefunds(SAMPLE_STATS), failures_counted: 0, refund_rate: 0.5 };
  assert.equal(shouldEmitSellerRefundedFailures(none), false);
  const low: DecisionHostRefunds = { ...sumHostRefunds({ ...SAMPLE_STATS, pay_tos: [SAMPLE_STATS.pay_tos[1]!] }) };
  assert.equal(low.refund_rate, 0.49);
  assert.equal(shouldEmitSellerRefundedFailures(low), false);
  const half: DecisionHostRefunds = sumHostRefunds({
    ...SAMPLE_STATS,
    pay_tos: [{ ...SAMPLE_STATS.pay_tos[0]!, paid_units: "1000", refunded_units: "500", refund_rate: 0.5 }],
  });
  assert.equal(shouldEmitSellerRefundedFailures(half), true);
});

test("attachSellerRefunds adds code at rate 0.5 without changing recommendation", async () => {
  const base = baseDecision();
  const rec = base.recommendation;
  const out = await attachSellerRefundsToDecision(base, SUBJECT.canonical_url, async () => ({
    ...SAMPLE_STATS,
    pay_tos: [{ ...SAMPLE_STATS.pay_tos[0]! }],
  }));
  assert.equal(out.recommendation, rec);
  assert.ok(out.reason_codes.includes(SELLER_REFUNDED_FAILURES));
  assert.equal(out.refunds?.refund_rate, 0.5);
  const reason = out.reasons.find((r) => r.code === SELLER_REFUNDED_FAILURES);
  assert.ok(reason);
  assert.equal(reason!.effect, "none");
  assert.equal(reason!.evidence[0]?.url, "https://vet402.com/sellers/refund-host.example");
});

test("attachSellerRefunds: read error → refunds null, no code, recommendation unchanged", async () => {
  const base = baseDecision();
  const out = await attachSellerRefundsToDecision(base, SUBJECT.canonical_url, async () => {
    throw new Error("db down");
  });
  assert.equal(out.refunds, null);
  assert.equal(out.recommendation, base.recommendation);
  assert.equal(out.reason_codes.includes(SELLER_REFUNDED_FAILURES), false);
});

test("attachSellerRefunds: 0 failures → refunds set but no code", async () => {
  const base = baseDecision();
  const out = await attachSellerRefundsToDecision(base, SUBJECT.canonical_url, async () => ({
    ...SAMPLE_STATS,
    pay_tos: [{ ...SAMPLE_STATS.pay_tos[0]!, failures_counted: 0, paid_units: "0", refunded_units: "0", refund_rate: null }],
  }));
  assert.equal(out.refunds?.failures_counted, 0);
  assert.equal(out.reason_codes.includes(SELLER_REFUNDED_FAILURES), false);
});