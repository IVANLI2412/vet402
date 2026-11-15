import assert from "node:assert/strict";
import test from "node:test";
import { publicEnglishFaults } from "@/lib/diagnose/copy";
import { formatRefundUsdcAmount, payToRefundLines, refundSectionLines } from "@/components/site/sellers/SellerRefundSection";
import type { PayToRefund, RefundStats } from "@/lib/sellers/refunds";

const row: PayToRefund = {
  pay_to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  listings_sharing: 1,
  failures_counted: 2,
  paid_units: "2000",
  refunded_units: "1000",
  refunded_units_raw: "1000",
  refund_rate: 0.5,
  refund_transfers: 2,
  refund_txs: [],
  failures_window_open: 0,
};

const stats: RefundStats = {
  pay_tos: [row],
  window_days: 30,
  networks_read: ["eip155:8453"],
  read_through: "2026-11-01T00:00:00.000Z",
  failures_not_read: 0,
};

test("every refund line passes the public English rules and never says guarantee", () => {
  const all = refundSectionLines({
    ...stats,
    failures_not_read: 1,
    pay_tos: [row, { ...row, pay_to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", listings_sharing: 3, refund_rate: null, paid_units: "0", refunded_units: "0", failures_window_open: 2 }],
  });
  assert.ok(all.length >= 6);
  for (const line of all) {
    assert.deepEqual(publicEnglishFaults(line), [], line);
    assert.ok(!line.toLowerCase().includes("guarantee"), line);
  }
});

test("the rate line puts the amount back next to the amount paid and the transfer count", () => {
  const [line] = payToRefundLines(row);
  assert.ok(line.includes("0.001 USDC of the 0.002 USDC"), line);
  assert.ok(line.includes("(50.00%)"), line);
  assert.ok(line.includes("2 refund transfers"), line);
});

test("no rate in the text when nothing is in the count", () => {
  const lines = payToRefundLines({ ...row, paid_units: "0", refunded_units: "0", refund_rate: null, failures_counted: 0 });
  assert.ok(lines.every((l) => !l.includes("%")));
  assert.ok(lines.some((l) => l.includes("no refund rate to show")));
});

test("a shared payTo says so and says the numbers are for the payTo", () => {
  const lines = payToRefundLines({ ...row, listings_sharing: 2 });
  assert.ok(lines[0].includes("is shared by 2 listings"), lines[0]);
  assert.ok(lines[0].includes("for the payTo as a whole"), lines[0]);
  assert.ok(!payToRefundLines(row).some((l) => l.includes("shared by")));
});

test("the definition names the held rows and the cap", () => {
  const text = refundSectionLines(stats).join(" ");
  assert.ok(text.includes("any settled 4xx"));
  assert.ok(text.includes("caps the sum at the amount paid"));
  assert.ok(text.includes("not tied to one purchase"));
});

test("formatRefundUsdcAmount trims trailing zeros", () => {
  assert.equal(formatRefundUsdcAmount("12000"), "0.012 USDC");
  assert.equal(formatRefundUsdcAmount("1000000"), "1 USDC");
  assert.equal(formatRefundUsdcAmount("1500000"), "1.5 USDC");
});
