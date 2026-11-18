import test from "node:test";
import assert from "node:assert/strict";
import { vet402PayTool } from "../dist/index.js";
import { URL_A, harness, parseResult } from "./_harness.mjs";

test("LangChain tool.invoke runs the payment path", async () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl });
  const raw = await payTool.invoke({ url: URL_A });
  const result = parseResult(raw);
  assert.equal(result.status, "paid");
  assert.equal(h.seen.signatures, 1);
});