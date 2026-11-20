import test from "node:test";
import assert from "node:assert/strict";
import { authorizationResourceKey, normalizeResourceUrlForAuth } from "../dist/authorization-resource-key.js";
import { hasLiveAuthorization, rememberLiveAuthorization } from "../dist/pending-payment.js";

const RID = "a".repeat(64);
const PAYEE = "0x1111111111111111111111111111111111111111";

test("URL variants share one live-authorization slot", () => {
  const base = "https://api.exa.ai/search";
  const key = authorizationResourceKey({ resourceUrl: base, payTo: PAYEE });
  rememberLiveAuthorization(key, Math.floor(Date.now() / 1000) + 600, "0xnonce");
  const variants = [
    base + "/",
    "https://API.exa.ai/search",
    "https://api.exa.ai./search",
    "https://api.exa.ai:443/search",
    base + "?",
  ];
  for (const v of variants) {
    const k = authorizationResourceKey({ resourceUrl: v, payTo: PAYEE });
    assert.equal(hasLiveAuthorization(k), true, v);
  }
});

test("resource_id key blocks variant spellings of the same listing", () => {
  const url = "https://api.exa.ai/search";
  const key = authorizationResourceKey({ resourceId: RID, payTo: PAYEE });
  rememberLiveAuthorization(key, Math.floor(Date.now() / 1000) + 600, "0xnonce");
  const norm = normalizeResourceUrlForAuth(url + "/");
  const alt = authorizationResourceKey({ resourceUrl: norm, resourceId: RID, payTo: PAYEE });
  assert.equal(hasLiveAuthorization(alt), true);
});