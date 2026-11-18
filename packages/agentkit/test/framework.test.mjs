import test from "node:test";
import assert from "node:assert/strict";
import { vet402ActionProvider } from "../dist/index.js";
import { URL_A, harness, parseResult } from "./_harness.mjs";

test("AgentKit action can be invoked from getActions", async () => {
  const h = harness();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("cca-lite.coinbase.com")) {
      return new Response("{}", { status: 200 });
    }
    return h.fetchImpl(input, init);
  };
  try {
    const provider = vet402ActionProvider({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
    const actions = provider.getActions({});
    const pay = actions.find((a) => a.name === "Vet402ActionProvider_vet402_pay");
    assert.ok(pay);
    const raw = await pay.invoke({ url: URL_A });
    const result = parseResult(raw);
    assert.equal(result.status, "paid");
    assert.equal(h.seen.signatures, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = priorFetch;
  }
});