import { test } from "node:test";
import assert from "node:assert/strict";

test("parseCatalogItem sets bazaarCurated from curated on Bazaar items", async () => {
  const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
  const accept = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xa", payTo: "0x1111111111111111111111111111111111111111" };
  assert.equal(
    parseCatalogItem({
      resource: "https://a.example/x",
      curated: true,
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    }).bazaarCurated,
    true,
  );
  assert.equal(
    parseCatalogItem({
      resource: "https://b.example/x",
      accepts: [accept],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
    }).bazaarCurated,
    false,
  );
  assert.equal(
    parseCatalogItem({
      resource: "https://c.example/x",
      metadata: { method: "GET" },
      accepts: [accept],
    }).bazaarCurated,
    null,
  );
});