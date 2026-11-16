import { test } from "node:test";
import assert from "node:assert/strict";
import { buyerCheckUrl, firstBuyerCheckUrl } from "@/lib/sellers/buyer-check";
import { SITE_URL } from "@/lib/site-url";

test("buyerCheckUrl encodes the listing url and method", () => {
  assert.equal(
    buyerCheckUrl("https://api.example.com/x402?a=1", "post"),
    `${SITE_URL}/api/v1/check?url=https%3A%2F%2Fapi.example.com%2Fx402%3Fa%3D1&method=POST`,
  );
  assert.equal(buyerCheckUrl("https://api.example.com/x", null), `${SITE_URL}/api/v1/check?url=https%3A%2F%2Fapi.example.com%2Fx`);
});

test("buyerCheckUrl skips http listings and drops a bad method", () => {
  assert.equal(buyerCheckUrl("http://api.example.com/x", "GET"), null);
  assert.equal(buyerCheckUrl("https://a.example/x", "G E T"), `${SITE_URL}/api/v1/check?url=https%3A%2F%2Fa.example%2Fx`);
});

test("firstBuyerCheckUrl picks the first https listing", () => {
  assert.equal(firstBuyerCheckUrl([]), null);
  assert.equal(
    firstBuyerCheckUrl([
      { resourceUrl: "http://a.example/x", method: null },
      { resourceUrl: "https://b.example/y", method: "GET" },
    ]),
    `${SITE_URL}/api/v1/check?url=https%3A%2F%2Fb.example%2Fy&method=GET`,
  );
});
