import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHostCalledVsDelivered, calledVsDeliveredLines } from "@/lib/sellers/called-vs-delivered";

test("buildHostCalledVsDelivered does not sum payers across listings", () => {
  const d = buildHostCalledVsDelivered({
    host: "host.example",
    readAt: "2026-11-15T00:00:00.000Z",
    bazaar: {
      calls30d: 10,
      listingsWithFigures: 2,
      listings: 3,
      payersLargestListing: 7,
      lastCalledAt: null,
      observedOldestAt: "2026-11-14T12:00:00.000Z",
      observedNewestAt: "2026-11-15T12:00:00.000Z",
    },
    vet402: { settled: 5, delivered: 2, heldSettled: 1 },
  });
  assert.equal(d.vet402.judged, 4);
  assert.equal(d.vet402.deliveredPct, 50);
  assert.equal(d.bazaar.payersLargestListing, 7);
});

test("calledVsDeliveredLines keeps CDP Bazaar with read time in the Bazaar column", () => {
  const data = buildHostCalledVsDelivered({
    host: "host.example",
    readAt: "2026-11-15T00:00:00.000Z",
    bazaar: {
      calls30d: 3,
      listingsWithFigures: 1,
      listings: 1,
      payersLargestListing: null,
      lastCalledAt: null,
      observedOldestAt: "2026-11-15T10:00:00.000Z",
      observedNewestAt: "2026-11-15T10:00:00.000Z",
    },
    vet402: { settled: 1, delivered: 1, heldSettled: 0 },
  });
  const lines = calledVsDeliveredLines(data);
  const bazaarChunk = lines.bazaar.join(" ");
  assert.match(bazaarChunk, /Bazaar catalog/);
  assert.match(bazaarChunk, /Read by vet402/);
  const vetChunk = lines.vet402.join(" ");
  assert.doesNotMatch(vetChunk, /Bazaar/i);
});

test("calledVsDeliveredLines when all settled are held", () => {
  const data = buildHostCalledVsDelivered({
    host: "host.example",
    readAt: "2026-11-15T00:00:00.000Z",
    bazaar: {
      calls30d: null,
      listingsWithFigures: 0,
      listings: 0,
      payersLargestListing: null,
      lastCalledAt: null,
      observedOldestAt: null,
      observedNewestAt: null,
    },
    vet402: { settled: 3, delivered: 0, heldSettled: 3 },
  });
  assert.equal(data.vet402.judged, 0);
  assert.equal(data.vet402.deliveredPct, null);
  const { vet402 } = calledVsDeliveredLines(data);
  assert.match(vet402.join(" "), /No settled purchase vet402 could judge/);
  assert.match(vet402.join(" "), /3 settled purchases got an HTTP 4xx/);
  assert.doesNotMatch(vet402.join(" "), /\bmore\b/i);
});

test("calls30d null when no rows with observed time", () => {
  const d = buildHostCalledVsDelivered({
    host: "host.example",
    readAt: "2026-11-15T00:00:00.000Z",
    bazaar: {
      calls30d: null,
      listingsWithFigures: 0,
      listings: 2,
      payersLargestListing: null,
      lastCalledAt: null,
      observedOldestAt: null,
      observedNewestAt: null,
    },
    vet402: { settled: 0, delivered: 0, heldSettled: 0 },
  });
  assert.equal(d.vet402.deliveredPct, null);
  assert.match(calledVsDeliveredLines(d).bazaar.join(" "), /no call count with a recorded read time/);
});