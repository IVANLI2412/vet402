import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSettlementIndexByChain } from "@/lib/observatory/settlement-index-status";
import { SOLANA_CHECKPOINT_SCOPE_PREFIX } from "@/lib/settlements/index-solana";

test("buildSettlementIndexByChain marks missing checkpoint as never_read", () => {
  const rows = buildSettlementIndexByChain({
    checkpoints: [{ scope: "settlements:eip155:8453", updatedAt: "2026-11-15T00:00:00.000Z" }],
    counts: [{ chain: "eip155:8453", settlements30d: 3, lastSettlementAt: "2026-11-14T00:00:00.000Z" }],
  });
  const base = rows.find((r) => r.chain === "eip155:8453");
  const celo = rows.find((r) => r.chain === "eip155:42220");
  assert.equal(base?.status, "read");
  assert.equal(base?.settlements30d, 3);
  assert.equal(celo?.status, "never_read");
  assert.equal(celo?.lastReadAt, null);
  assert.equal(celo?.settlements30d, 0);
});

test("Solana uses max of multiple checkpoint scopes", () => {
  const rows = buildSettlementIndexByChain({
    checkpoints: [
      { scope: `${SOLANA_CHECKPOINT_SCOPE_PREFIX}aaa`, updatedAt: "2026-11-10T00:00:00.000Z" },
      { scope: `${SOLANA_CHECKPOINT_SCOPE_PREFIX}bbb`, updatedAt: "2026-11-15T00:00:00.000Z" },
    ],
    counts: [],
  });
  const sol = rows.find((r) => r.chain === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(sol?.lastReadAt, "2026-11-15T00:00:00.000Z");
});