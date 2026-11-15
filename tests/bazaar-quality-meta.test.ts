import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalogItem } from "@/lib/observatory/catalog-source";
import { __resetBazaarQualityWarningForTests, writeBazaarQualityMeta } from "@/lib/observatory/catalog-bazaar-quality";

const accept = { scheme: "exact", network: "eip155:8453", amount: "1", asset: "0xa", payTo: "0x3333333333333333333333333333333333333333" };
const item = parseCatalogItem({
  resource: "https://meta.test/x",
  quality: { l30DaysTotalCalls: 3 },
  accepts: [accept],
  extensions: { bazaar: { info: { input: { method: "GET" } } } },
});

test("a missing-column error skips the two columns, warns once, and does not throw", async () => {
  __resetBazaarQualityWarningForTests();
  const warnings: string[] = [];
  const db = {
    execute: async () => {
      throw Object.assign(new Error("column \"quality_observed_at\" does not exist"), { cause: { code: "42703" } });
    },
  };
  const first = await writeBazaarQualityMeta(db, [item], new Date(), (l) => warnings.push(l));
  const second = await writeBazaarQualityMeta(db, [item], new Date(), (l) => warnings.push(l));
  assert.equal(first.status, "skipped_missing_columns");
  assert.equal(second.status, "skipped_missing_columns");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2026-11-15-bazaar-quality-observed\.sql/);
});

test("other database errors still throw", async () => {
  const db = {
    execute: async () => {
      throw Object.assign(new Error("connection reset"), { code: "08006" });
    },
  };
  await assert.rejects(writeBazaarQualityMeta(db, [item], new Date(), () => {}));
});

test("no items means no query", async () => {
  let calls = 0;
  const db = { execute: async () => { calls++; return []; } };
  const r = await writeBazaarQualityMeta(db, [], new Date(), () => {});
  assert.equal(r.status, "nothing_to_write");
  assert.equal(calls, 0);
});
