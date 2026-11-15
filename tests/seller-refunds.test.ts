// C4 の返金の数え方（payTo 単位の金額・2026-11-16）。純関数だけ。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PAYER_PERIODS } from "@/lib/sellers/payers";
import { isBadPaid, isExcludedPayTo, refundStats, type RefundPurchase, type RefundTransfer } from "@/lib/sellers/refunds";

const PAYER = BASE_PAYER_PERIODS[1]!.address.toLowerCase();
const OLD_PAYER = BASE_PAYER_PERIODS[0]!.address.toLowerCase();
const OTHER_PAYER = "0x1111111111111111111111111111111111111111";
const PAY_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAY_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc";
const READ_THROUGH = "2026-12-01T00:00:00.000Z";

function purchase(over: Partial<RefundPurchase> & Pick<RefundPurchase, "id">): RefundPurchase {
  return {
    endpointId: "ep-a",
    host: "a.example",
    status: "settled",
    network: "eip155:8453",
    payer: PAYER,
    payTo: PAY_A,
    amountUnits: "1000",
    attemptedAt: "2026-10-01T12:00:00.000Z",
    httpStatusPaid: 500,
    sellerSide: true,
    ...over,
  };
}

function transfer(over: Partial<RefundTransfer> & Pick<RefundTransfer, "txHash">): RefundTransfer {
  return {
    chain: "eip155:8453",
    logIndex: 0,
    from: PAY_A,
    to: PAYER,
    amount: "1000",
    blockTime: "2026-10-02T12:00:00.000Z",
    ...over,
  };
}

function only(stats: ReturnType<typeof refundStats>, payTo = PAY_A) {
  const r = stats.pay_tos.find((x) => x.pay_to === payTo);
  assert.ok(r, `payTo ${payTo} is in the stats`);
  return r!;
}

test("A 1000 and B 1000 with 500 + 500 back: paid 2000, back 1000, rate 50%, no double count", () => {
  const r = only(
    refundStats(
      [purchase({ id: "A" }), purchase({ id: "B", attemptedAt: "2026-10-02T12:00:00.000Z" })],
      [
        transfer({ txHash: "0x1", amount: "500", blockTime: "2026-10-05T00:00:00.000Z" }),
        transfer({ txHash: "0x2", amount: "500", blockTime: "2026-10-06T00:00:00.000Z" }),
      ],
      READ_THROUGH,
    ),
  );
  assert.equal(r.paid_units, "2000");
  assert.equal(r.refunded_units, "1000");
  assert.equal(r.refund_rate, 0.5);
  assert.equal(r.refund_transfers, 2);
  assert.equal(r.failures_counted, 2);
});

test("the same transfer listed twice counts once", () => {
  const t = transfer({ txHash: "0xdup", amount: "400" });
  const r = only(refundStats([purchase({ id: "A" })], [t, { ...t }], READ_THROUGH));
  assert.equal(r.refunded_units, "400");
  assert.equal(r.refund_transfers, 1);
});

test("the sum back is capped at the amount paid", () => {
  const r = only(
    refundStats(
      [purchase({ id: "A" })],
      [transfer({ txHash: "0x1", amount: "800" }), transfer({ txHash: "0x2", amount: "800", blockTime: "2026-10-03T00:00:00.000Z" })],
      READ_THROUGH,
    ),
  );
  assert.equal(r.refunded_units_raw, "1600");
  assert.equal(r.refunded_units, "1000");
  assert.equal(r.refund_rate, 1);
  // The list adds up to the capped amount: 800 then the remaining 200.
  assert.deepEqual(r.refund_txs.map((t) => t.amount_units), ["800", "200"]);
  assert.equal(r.refund_transfers, 2);
  const third = only(
    refundStats(
      [purchase({ id: "A" })],
      [
        transfer({ txHash: "0x1", amount: "800" }),
        transfer({ txHash: "0x2", amount: "800", blockTime: "2026-10-03T00:00:00.000Z" }),
        transfer({ txHash: "0x3", amount: "800", blockTime: "2026-10-04T00:00:00.000Z" }),
      ],
      READ_THROUGH,
    ),
  );
  assert.equal(third.refund_transfers, 2);
  assert.equal(third.refund_txs.reduce((a, t) => a + BigInt(t.amount_units), 0n), 1000n);
});

test("transfers that do not count: stranger, other payTo, other wallet, before, after 30 days, other network", () => {
  const r = only(
    refundStats(
      [purchase({ id: "A" })],
      [
        transfer({ txHash: "0xs", from: STRANGER }),
        transfer({ txHash: "0xb", from: PAY_B }),
        transfer({ txHash: "0xw", to: OTHER_PAYER }),
        transfer({ txHash: "0xbefore", blockTime: "2026-09-30T00:00:00.000Z" }),
        transfer({ txHash: "0xlate", blockTime: "2026-10-31T12:00:01.000Z" }),
        transfer({ txHash: "0xcelo", chain: "eip155:42220" }),
      ],
      READ_THROUGH,
    ),
  );
  assert.equal(r.refunded_units, "0");
  assert.equal(r.refund_transfers, 0);
  assert.equal(r.refund_rate, 0);
});

test("a transfer exactly 30 days after the failure counts", () => {
  const r = only(refundStats([purchase({ id: "A" })], [transfer({ txHash: "0x30", blockTime: "2026-10-31T12:00:00.000Z" })], READ_THROUGH));
  assert.equal(r.refunded_units, "1000");
});

test("a refund to either vet402 Base payer counts, not only the payer that made the failed purchase", () => {
  const same = only(refundStats([purchase({ id: "A", payer: OLD_PAYER })], [transfer({ txHash: "0xo", to: OLD_PAYER })], READ_THROUGH));
  assert.equal(same.refunded_units, "1000");
  const other = only(refundStats([purchase({ id: "A", payer: OLD_PAYER })], [transfer({ txHash: "0xn", to: PAYER })], READ_THROUGH));
  assert.equal(other.refunded_units, "1000");
  assert.equal(other.refund_rate, 1);
});

test("the denominator takes only seller-side settled failures by the vet402 Base payer", () => {
  assert.equal(isBadPaid(purchase({ id: "p" })), true);
  assert.equal(isBadPaid(purchase({ id: "p", httpStatusPaid: 200, payloadNonEmpty: true })), false);
  assert.equal(isBadPaid(purchase({ id: "p", httpStatusPaid: 400, txHash: "0xabc" })), false);
  assert.equal(isBadPaid(purchase({ id: "p", httpStatusPaid: 202 })), false);
  assert.equal(isBadPaid(purchase({ id: "p", sellerSide: false })), false);
  assert.equal(isBadPaid(purchase({ id: "p", payer: OTHER_PAYER })), false);
  assert.equal(isBadPaid(purchase({ id: "p", status: "settle_failed" })), false);
  assert.equal(isBadPaid(purchase({ id: "p", status: "voided" })), false);
});

test("a settled 400 and a settled 202 never enter the amount paid, even with a refund on chain", () => {
  const r = only(
    refundStats(
      [purchase({ id: "s400", httpStatusPaid: 400, txHash: "0xabc" }), purchase({ id: "s202", httpStatusPaid: 202 })],
      [transfer({ txHash: "0xr" })],
      READ_THROUGH,
    ),
  );
  assert.equal(r.paid_units, "0");
  assert.equal(r.refund_rate, null);
  assert.equal(r.refund_transfers, 0);
});

test("no rate when nothing is in the count", () => {
  const r = only(refundStats([purchase({ id: "ok", httpStatusPaid: 200, payloadNonEmpty: true })], [], READ_THROUGH));
  assert.equal(r.paid_units, "0");
  assert.equal(r.refund_rate, null);
});

test("a failure whose 30 days are not read stays out of the amount and its refunds do not count", () => {
  const stats = refundStats([purchase({ id: "A", attemptedAt: "2026-11-20T00:00:00.000Z" })], [transfer({ txHash: "0x1", blockTime: "2026-11-21T00:00:00.000Z" })], READ_THROUGH);
  const r = only(stats);
  assert.equal(r.failures_window_open, 1);
  assert.equal(r.paid_units, "0");
  assert.equal(r.refund_rate, null);
  assert.equal(r.refund_transfers, 0);
  const none = only(refundStats([purchase({ id: "A" })], [transfer({ txHash: "0x1" })], null));
  assert.equal(none.failures_window_open, 1);
  assert.equal(none.refund_rate, null);
});

test("purchases on networks vet402 does not read are counted apart", () => {
  const stats = refundStats([purchase({ id: "c", network: "eip155:42220" }), purchase({ id: "A" })], [], READ_THROUGH);
  assert.equal(stats.failures_not_read, 1);
  assert.equal(only(stats).failures_counted, 1);
});

test("a payTo shared by listings on two hosts gives one payTo-level number and says it is shared", () => {
  const purchases = [purchase({ id: "a1", endpointId: "ep-a", host: "a.example" }), purchase({ id: "b1", endpointId: "ep-b", host: "b.example" })];
  const tx = [transfer({ txHash: "0xshared", amount: "1000" })];
  const fromA = only(refundStats(purchases, tx, READ_THROUGH, [PAY_A]));
  const fromB = only(refundStats(purchases, tx, READ_THROUGH, [PAY_A]));
  assert.deepEqual(fromA, fromB);
  assert.equal(fromA.listings_sharing, 2);
  assert.equal(fromA.paid_units, "2000");
  assert.equal(fromA.refunded_units, "1000");
  assert.equal(fromA.refund_rate, 0.5);
});

test("operator payTo and the vet402 payer wallets as payTo are never counted", () => {
  const prev = process.env.VET402_OPERATOR_PAYTO;
  const OPERATOR = "0xdddddddddddddddddddddddddddddddddddddddd";
  process.env.VET402_OPERATOR_PAYTO = OPERATOR;
  try {
    assert.equal(isExcludedPayTo(OPERATOR), true);
    assert.equal(isExcludedPayTo(PAYER), true);
    assert.equal(isExcludedPayTo(OLD_PAYER), true);
    const stats = refundStats(
      [purchase({ id: "op", payTo: OPERATOR }), purchase({ id: "self", payTo: PAYER })],
      [transfer({ txHash: "0xop", from: OPERATOR }), transfer({ txHash: "0xself", from: PAYER })],
      READ_THROUGH,
    );
    assert.equal(stats.pay_tos.length, 0);
  } finally {
    if (prev === undefined) delete process.env.VET402_OPERATOR_PAYTO;
    else process.env.VET402_OPERATOR_PAYTO = prev;
  }
});

test("the payer wallets are left out even when VET402_OPERATOR_PAYTO is empty", () => {
  const prev = process.env.VET402_OPERATOR_PAYTO;
  process.env.VET402_OPERATOR_PAYTO = "";
  try {
    assert.equal(isExcludedPayTo(PAYER), true);
  } finally {
    if (prev === undefined) delete process.env.VET402_OPERATOR_PAYTO;
    else process.env.VET402_OPERATOR_PAYTO = prev;
  }
});

