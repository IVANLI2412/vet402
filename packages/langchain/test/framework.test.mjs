import test from "node:test";
import assert from "node:assert/strict";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { vet402PayTool } from "../dist/index.js";
import { URL_A, harness, parseResult } from "./_harness.mjs";

test("LangChain tool.invoke runs the payment path", async () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  const raw = await payTool.invoke({ url: URL_A });
  const result = parseResult(raw);
  assert.equal(result.status, "paid");
  assert.equal(h.seen.signatures, 1);
});

test("LangChain invalid tool input returns refusal instead of throwing", async () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  const raw = await payTool.invoke({ url: 42 });
  const result = parseResult(raw);
  assert.equal(result.status, "refused");
  assert.equal(result.reasonCodes[0], "tool_input_invalid_url");
  assert.equal(h.seen.signatures, 0);
});

test("LangChain null tool input returns refusal instead of throwing", async () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  const raw = await payTool.invoke(null);
  const result = parseResult(raw);
  assert.equal(result.status, "refused");
  assert.equal(result.reasonCodes[0], "tool_input_invalid");
  assert.equal(h.seen.signatures, 0);
});

test("LangChain array tool input returns refusal instead of throwing", async () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  const raw = await payTool.invoke([URL_A]);
  const result = parseResult(raw);
  assert.equal(result.status, "refused");
  assert.equal(result.reasonCodes[0], "tool_input_invalid");
  assert.equal(h.seen.signatures, 0);
});

test("LangChain tool schema documents url, method, body and headers", () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  const shape = payTool.schema.shape;
  assert.ok(shape.url._def.description?.includes("HTTPS"));
  assert.ok(shape.method._def.description?.includes("HTTP method"));
  assert.ok(shape.body._def.description?.includes("body"));
  assert.ok(shape.headers._def.description?.includes("headers"));
});

test("LangChain convertToOpenAITool exposes object parameters with required url", () => {
  const h = harness();
  const payTool = vet402PayTool({ account: h.account, fetch: h.fetchImpl, allowedHosts: ["seller.example"] });
  const openAi = convertToOpenAITool(payTool);
  const params = openAi.function.parameters;
  assert.equal(params.type, "object");
  assert.equal(params.properties.url.type, "string");
  assert.ok(params.required.includes("url"));
  assert.ok(params.properties.method.description?.includes("HTTP method"));
  assert.ok(params.properties.body.description?.includes("body"));
  assert.ok(params.properties.headers.description?.includes("headers"));
});