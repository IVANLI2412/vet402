import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const FORBIDDEN = ["alchemy", "blockscout", "x402-payer", "l1-runner", "ALCHEMY", "INFURA", "QUICKNODE"];
const NO_CHAIN = ["chain/client", "chunked-logs"];

const FILES = [
  "src/lib/sellers/refunds.ts",
  "src/lib/sellers/refund-index.ts",
  "src/lib/sellers/refund-reader.ts",
  "src/components/site/sellers/SellerRefundSection.tsx",
];

test("refund modules do not reference paid RPC or payment runners", () => {
  for (const rel of FILES) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
  for (const word of FORBIDDEN) {
      assert.ok(!src.includes(word), `${rel} mentions ${word}`);
    }
    if (rel.endsWith("refund-reader.ts") || rel.endsWith("SellerRefundSection.tsx")) {
      for (const frag of NO_CHAIN) {
        assert.ok(!src.includes(frag), `${rel} imports ${frag}`);
      }
    }
  }
});