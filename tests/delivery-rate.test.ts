// 届いた率の公開式 v1.0-wilson95（計画 v3 §5.1）の値を固定する。式を変えたら版を上げること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_RATE_FORMULA, deliveryRate, deliveryRateBand, wilsonLowerBps } from "@/lib/delivery/delivery-rate";
import { deliveryFeedPublicRow, DELIVERY_FEED_PUBLIC_ROW_KEYS } from "@/lib/delivery/sellers-feed";

test("formula id is pinned", () => {
  assert.equal(DELIVERY_RATE_FORMULA, "v1.0-wilson95");
});

test("small samples do not read as 100%", () => {
  assert.equal(wilsonLowerBps(1, 1), 2065);
  assert.equal(wilsonLowerBps(2, 2), 3423);
  assert.equal(wilsonLowerBps(5, 5), 5655);
  assert.equal(wilsonLowerBps(12, 12), 7574);
  assert.equal(wilsonLowerBps(30, 30), 8864);
  assert.equal(wilsonLowerBps(100, 100), 9630);
  assert.equal(wilsonLowerBps(11, 12), 6461);
  assert.equal(wilsonLowerBps(0, 3), 0);
});

test("nothing settled is null, not 0%; bad input is null", () => {
  assert.equal(wilsonLowerBps(0, 0), null);
  assert.equal(wilsonLowerBps(3, 2), null);
  assert.equal(wilsonLowerBps(-1, 2), null);
  assert.equal(wilsonLowerBps(1.5, 2), null);
});

test("bands", () => {
  assert.equal(deliveryRateBand(4), "insufficient");
  assert.equal(deliveryRateBand(5), "provisional");
  assert.equal(deliveryRateBand(29), "provisional");
  assert.equal(deliveryRateBand(30), "established");
  assert.deepEqual(deliveryRate(28, 2), { lower_bps: 7867, band: "established" });
});

test("feed public row carries the rate and exactly the public keys", () => {
  const row = deliveryFeedPublicRow({
    endpoint_id: "e1",
    url: "https://a.example/x",
    method: "GET",
    network: "eip155:8453",
    price_usd: 0.01,
    listed_in: "bazaar",
    bazaar_payers_30d: 3,
    paid_attempts_30d: 4,
    delivered_30d: 2,
    settled_not_delivered_30d: 1,
    last_attempt_at_30d: null,
    last_delivered_at_30d: null,
    record_url: "https://vet402.com/observatory/e/e1",
    window_purchase_networks: ["eip155:8453"],
  });
  assert.equal(row.delivery_rate_lower_bps_30d, wilsonLowerBps(2, 3));
  assert.equal(row.delivery_rate_band_30d, "insufficient");
  assert.deepEqual(Object.keys(row).sort(), [...DELIVERY_FEED_PUBLIC_ROW_KEYS].sort());
});
