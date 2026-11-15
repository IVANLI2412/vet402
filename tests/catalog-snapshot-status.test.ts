import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogSnapshotStatus, publicCatalogSnapshots } from "@/lib/observatory/catalog-snapshot-status";

test("catalogSnapshotStatus marks fetch_failed", () => {
  assert.equal(catalogSnapshotStatus({ complete: false, fetchedCount: 0, totalCount: 100 }), "fetch_failed");
  assert.equal(catalogSnapshotStatus({ complete: false, fetchedCount: 1, totalCount: 100 }), "partial");
});

test("publicCatalogSnapshots nulls counts on fetch_failed and adds not_yet_read", () => {
  const out = publicCatalogSnapshots([
    { source: "rail402_discovery", snapshotDate: "2026-11-15", totalCount: 0, fetchedCount: 0, complete: false },
    { source: "cdp_bazaar", snapshotDate: "2026-11-15", totalCount: 100, fetchedCount: 100, complete: true },
  ]);
  const rail = out.find((r) => r.source === "rail402_discovery");
  assert.equal(rail?.status, "fetch_failed");
  assert.equal(rail?.totalCount, null);
  assert.equal(rail?.fetchedCount, null);
  const payai = out.find((r) => r.source === "payai_discovery");
  assert.equal(payai?.status, "not_yet_read");
  assert.equal(payai?.totalCount, null);
});