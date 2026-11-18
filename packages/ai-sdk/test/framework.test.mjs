import test from "node:test";
import assert from "node:assert/strict";
import { vet402PayTool } from "../dist/index.js";
import { URL_A, harness } from "./_harness.mjs";

test("AI SDK tool execute runs the payment path", async () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  assert.equal(typeof payTool.execute, "function");
  const result = await payTool.execute({ url: URL_A });
  assert.equal(result.status, "paid");
  assert.equal(h.seen.signatures, 1);
});