// Run: npx tsx --test tests/answer-check-judges.test.ts
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredRequestBodyFromDoc, declaredRequestUrlFromDoc } from "@/lib/observatory/declared-input-rules";
import {
  checkBinaryKind,
  checkDeclaredType,
  checkInputEcho,
  checkJsonValid,
  checkShapeDrift,
  completeBodyOf,
  runAnswerChecks,
  type StoredAnswer,
} from "@/lib/observatory/answer-check";

const base = (over: Partial<StoredAnswer>): StoredAnswer => ({
  purchaseId: over.purchaseId ?? "p1",
  endpointKey: over.endpointKey ?? "ep1",
  attemptedAt: over.attemptedAt ?? "2026-11-10T00:00:00.000Z",
  status: "settled",
  httpStatus: 200,
  contentType: "application/json",
  bodyHead: '{"a":1}',
  bodyBytes: 7,
  resourceUrl: "https://example.com/api?q=1",
  challengeDocument: {},
  requestQuery: null,
  requestQuerySha256: null,
  requestBody: null,
  requestBodySha256: null,
  catalogDeclaredSchema: null,
  l2Reading: null,
  bodyIncomplete: null,
  ...over,
});

test("json_valid: pass と fail と not_checked", () => {
  assert.equal(checkJsonValid(base({ bodyHead: '{"x":1}', bodyBytes: 7 })).result, "pass");
  assert.equal(checkJsonValid(base({ bodyHead: "{bad", bodyBytes: 4, contentType: "application/json" })).result, "fail");
  assert.equal(checkJsonValid(base({ bodyHead: "{bad", bodyBytes: 4, contentType: "application/json" })).reason, "unparseable");
  assert.equal(checkJsonValid(base({ bodyHead: "{bad", bodyBytes: 4, contentType: "text/plain" })).result, "not_checked");
  assert.equal(checkJsonValid(base({ bodyHead: "x".repeat(500), bodyBytes: 1000, contentType: "application/json" })).reason, "body_longer_than_stored_head");
  assert.equal(checkJsonValid(base({ httpStatus: 500 })).result, "not_applicable");
});

test("declared_type: 見本の数値 2 は number 宣言で 2.5 も pass", () => {
  const catalog = {
    properties: {
      output: {
        properties: {
          example: { properties: { price: 2, sym: "BTC" } },
        },
      },
    },
  };
  const v = checkDeclaredType(
    base({
      catalogDeclaredSchema: catalog,
      challengeDocument: {},
      bodyHead: '{"price":2.5,"sym":"ETH"}',
      bodyBytes: 25,
    }),
  );
  assert.equal(v.result, "pass");
});

test("declared_type: pass と fail", () => {
  const catalog = {
    properties: {
      output: { properties: { example: { properties: { price: { type: "number" }, sym: { type: "string" } } } } },
    },
  };
  const doc = {
    accepts: [
      {
        outputSchema: {
          output: {
            properties: { price: { type: "integer" }, sym: { type: "string" } },
            example: { price: 1, sym: "BTC" },
          },
        },
      },
    ],
  };
  const pass = checkDeclaredType(base({ catalogDeclaredSchema: catalog, challengeDocument: doc, bodyHead: '{"price":2,"sym":"ETH"}', bodyBytes: 23 }));
  assert.equal(pass.result, "pass");
  const fail = checkDeclaredType(base({ catalogDeclaredSchema: catalog, challengeDocument: doc, bodyHead: '{"price":"x","sym":"ETH"}', bodyBytes: 25 }));
  assert.equal(fail.result, "fail");
  assert.equal(fail.reason, "type_differs");
});

test("shape_drift: 入れ子のキーを最上位と取り違えない", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json" });
  const m = checkShapeDrift([
    mk("n1", "2026-11-01T00:00:00Z", '{"wrap":{"inner":1},"k":1}', 26),
    mk("n2", "2026-11-02T00:00:00Z", '{"wrap":{"other":9},"k":1}', 26),
  ]);
  assert.equal(m.get("n2")?.result, "pass");
  assert.equal(m.get("n2")?.reason, "same_shape");
});

test("shape_drift: 402 の JSON 宣言がある掲載は not_applicable declared", () => {
  const doc = {
    accepts: [
      {
        outputSchema: {
          output: { properties: { x: { type: "number" } }, required: ["x"] },
        },
      },
    ],
  };
  const mk = (id: string) =>
    base({
      purchaseId: id,
      bodyHead: '{"x":1}',
      bodyBytes: 7,
      catalogDeclaredSchema: null,
      challengeDocument: doc,
    });
  assert.equal(checkShapeDrift([mk("j1")]).get("j1")?.reason, "declared");
});

test("shape_drift: 基準・同一・キー消失・キー追加は pass/fail", () => {
  const mk = (id: string, at: string, body: string, bytes: number, catalog: unknown = null) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json", catalogDeclaredSchema: catalog });
  const undeclared = [
    mk("a1", "2026-11-01T00:00:00Z", '{"k":1}', 7),
    mk("a2", "2026-11-02T00:00:00Z", '{"k":1}', 7),
    mk("a3", "2026-11-03T00:00:00Z", '{"k":1,"extra":2}', 17),
  ];
  const m = checkShapeDrift(undeclared);
  assert.equal(m.get("a1")?.reason, "baseline");
  assert.equal(m.get("a2")?.result, "pass");
  assert.equal(m.get("a3")?.result, "pass");
  assert.equal(m.get("a3")?.reason, "same_shape");
  const removed = checkShapeDrift([
    mk("b1", "2026-11-01T00:00:00Z", '{"a":1,"b":2}', 13),
    mk("b2", "2026-11-02T00:00:00Z", '{"a":1}', 7),
  ]);
  assert.equal(removed.get("b2")?.result, "fail");
  assert.equal(removed.get("b2")?.reason, "shape_changed");
  const declared = checkShapeDrift([mk("c1", "2026-11-01T00:00:00Z", '{"x":1}', 7, { properties: { output: { properties: { example: { required: ["x"] } } } } })]);
  assert.equal(declared.get("c1")?.reason, "declared");
});

test("input_echo: declared なのに resourceUrl が無いと sent_values_unverified", () => {
  const v = checkInputEcho(
    base({
      requestQuery: "declared",
      resourceUrl: null,
      bodyHead: '{"x":1}',
      bodyBytes: 7,
    }),
  );
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "sent_values_unverified");
});

test("input_echo: 空文字は両方空のときだけ一致", () => {
  const url = "https://example.com/path";
  const doc = { extensions: { bazaar: { info: { input: { queryParams: { q: "" } } } } } };
  const declared = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
  const sha = createHash("sha256").update(declared.query!, "utf8").digest("hex");
  const v = checkInputEcho(
    base({
      resourceUrl: url,
      challengeDocument: doc,
      requestQuery: "declared",
      requestQuerySha256: sha,
      bodyHead: '{"q":"x"}',
      bodyBytes: 9,
    }),
  );
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "echo_not_confirmed");
});

test("input_echo: sha256 一致で pass、不一致で not_checked", () => {
  const url = "https://example.com/path";
  const doc = {
    extensions: { bazaar: { info: { input: { queryParams: { domain: "github.com" } } } } },
  };
  const declared = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
  const query = declared.query!;
  const sha = createHash("sha256").update(query, "utf8").digest("hex");
  const ok = checkInputEcho(
    base({
      resourceUrl: url,
      challengeDocument: doc,
      requestQuery: "declared",
      requestQuerySha256: sha,
      bodyHead: '{"domain":"github.com"}',
      bodyBytes: 23,
    }),
  );
  assert.equal(ok.result, "pass");
  const bad = checkInputEcho(
    base({
      resourceUrl: url,
      challengeDocument: doc,
      requestQuery: "declared",
      requestQuerySha256: "deadbeef",
      bodyHead: '{"domain":"github.com"}',
      bodyBytes: 23,
    }),
  );
  assert.equal(bad.result, "not_checked");
  assert.equal(bad.reason, "sent_values_unverified");
});

test("shape_drift: attemptedAt は Date.parse で昇順（ミリ秒差でキー追加だけは keys_added）", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json" });
  const m = checkShapeDrift([
    mk("ms1", "2026-11-02T00:00:00Z", '{"k":1}', 7),
    mk("ms2", "2026-11-02T00:00:00.001Z", '{"k":1,"extra":2}', 17),
  ]);
  assert.equal(m.get("ms1")?.reason, "baseline");
  assert.equal(m.get("ms2")?.result, "pass");
  assert.equal(m.get("ms2")?.reason, "same_shape");
});

test("shape_drift: 読めない attemptedAt は bad_attempted_at", () => {
  const m = checkShapeDrift([
    base({ purchaseId: "bad1", attemptedAt: "not-a-date", bodyHead: '{"k":1}', bodyBytes: 7 }),
  ]);
  assert.equal(m.get("bad1")?.reason, "bad_attempted_at");
});

test("shape_drift: 配列の先頭がオブジェクトから文字列へ変わったら shape_changed（fail・outcome は unknown）", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json" });
  const m = checkShapeDrift([
    mk("ar1", "2026-11-01T00:00:00Z", '[{"a":1}]', 9),
    mk("ar2", "2026-11-02T00:00:00Z", '["x"]', 5),
  ]);
  assert.equal(m.get("ar2")?.result, "fail");
  assert.equal(m.get("ar2")?.reason, "shape_changed");
});

test("shape_drift: trim 後に < で始まれば html で、html と空の本文は基準にしない（failure_like_body）", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "text/html" });
  const m = checkShapeDrift([
    mk("ht1", "2026-11-01T00:00:00Z", "  <p>x</p>", 10),
    mk("ht2", "2026-11-02T00:00:00Z", "  <p>y</p>", 10),
  ]);
  assert.equal(m.get("ht1")?.reason, "failure_like_body");
  assert.equal(m.get("ht2")?.result, "not_applicable");
  assert.equal(m.get("ht2")?.reason, "failure_like_body");
  // 空の本文も基準にせず、次の JSON が基準になる。
  const e = checkShapeDrift([
    base({ purchaseId: "em1", attemptedAt: "2026-11-01T00:00:00Z", bodyHead: "", bodyBytes: 0 }),
    base({ purchaseId: "em2", attemptedAt: "2026-11-02T00:00:00Z", bodyHead: '{"a":1}', bodyBytes: 7 }),
  ]);
  assert.equal(e.get("em1")?.reason, "failure_like_body");
  assert.equal(e.get("em2")?.reason, "baseline");
});

test("json_valid: Content-Type が JSON でも空・空白だけ・長さの記録が無い本文は fail にしない", () => {
  assert.equal(checkJsonValid(base({ bodyHead: "", bodyBytes: 0 })).result, "not_checked");
  assert.equal(checkJsonValid(base({ bodyHead: "   ", bodyBytes: 3 })).reason, "empty_body");
  const unknownLen = checkJsonValid(base({ bodyHead: "{bad", bodyBytes: null }));
  assert.equal(unknownLen.result, "not_checked");
  assert.equal(unknownLen.reason, "body_length_unknown");
  assert.equal(checkJsonValid(base({ bodyHead: "{bad", bodyBytes: 4 })).result, "fail");
});

test("input_echo: 文字列は完全一致だけ（lang=ja と \"Japanese\" は not_checked）", () => {
  const url = "https://example.com/x";
  const doc = { extensions: { bazaar: { info: { input: { queryParams: { lang: "ja" } } } } } };
  const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
  const sha = createHash("sha256").update(query!, "utf8").digest("hex");
  const mk = (body: string) =>
    checkInputEcho(base({ resourceUrl: url, challengeDocument: doc, requestQuery: "declared", requestQuerySha256: sha, bodyHead: body, bodyBytes: Buffer.byteLength(body) }));
  const v = mk('{"lang":"Japanese"}');
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "echo_not_confirmed");
  assert.equal(mk('{"lang":" JA "}').result, "pass");
});

test("input_echo: 数値は部分一致しない（limit=10 と 100 は echo_not_confirmed）", () => {
  const doc = {
    extensions: { bazaar: { info: { input: { queryParams: { limit: "10" } } } } },
  };
  const url = "https://example.com/x";
  const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
  const sha = createHash("sha256").update(query!, "utf8").digest("hex");
  const v = checkInputEcho(
    base({
      resourceUrl: url,
      challengeDocument: doc,
      requestQuery: "declared",
      requestQuerySha256: sha,
      bodyHead: '{"limit":"100"}',
      bodyBytes: 15,
    }),
  );
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "echo_not_confirmed");
});

test("input_echo: 真偽値は true/false 文字列と完全一致のみ", () => {
  const bodyDoc = {
    extensions: { bazaar: { info: { input: { body: { active: true } } } } },
  };
  const { body, source } = declaredRequestBodyFromDoc(bodyDoc);
  assert.equal(source, "declared");
  const sha = createHash("sha256").update(body, "utf8").digest("hex");
  const ok = checkInputEcho(
    base({
      challengeDocument: bodyDoc,
      requestBody: "declared",
      requestBodySha256: sha,
      bodyHead: '{"active":"true"}',
      bodyBytes: 17,
    }),
  );
  assert.equal(ok.result, "pass");
  const bad = checkInputEcho(
    base({
      challengeDocument: bodyDoc,
      requestBody: "declared",
      requestBodySha256: sha,
      bodyHead: '{"active":"yes"}',
      bodyBytes: 16,
    }),
  );
  assert.equal(bad.result, "not_checked");
  assert.equal(bad.reason, "echo_not_confirmed");
});

test("declared_type: type 付きでも語彙外キーがあれば見本オブジェクト（見本由来の型の違いは fail にせず not_checked）", () => {
  const catalog = {
    properties: {
      output: { properties: { example: { properties: { mode: { type: "string", value: "abc" } } } } },
    },
  };
  const v = checkDeclaredType(
    base({
      catalogDeclaredSchema: catalog,
      bodyHead: '{"mode":"plain"}',
      bodyBytes: 16,
    }),
  );
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "example_type_differs");
  assert.equal(v.detail?.declared, "object");
  assert.equal(v.detail?.actual, "string");
});

test("completeBodyOf: bodyIncomplete が true なら null", () => {
  assert.equal(completeBodyOf(base({ bodyHead: '{"a":1}', bodyBytes: 7, bodyIncomplete: true })), null);
});

test("runAnswerChecks: bodyHead が非文字列でも全体が落ちない", () => {
  const row = base({ purchaseId: "x1", bodyHead: null as unknown as string });
  const m = runAnswerChecks([row]);
  const vs = m.get("x1") ?? [];
  assert.equal(vs.length, 5);
  for (const v of vs) {
    assert.notEqual(v.result, undefined);
    assert.notEqual(v.reason, "judge_error");
  }
});

test("binary_kind: pass と fail", () => {
  const qrDoc = { accepts: [{ outputSchema: { type: "string", contentMediaType: "image/png" } }] };
  const png = new TextDecoder().decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(checkBinaryKind(base({ challengeDocument: qrDoc, bodyHead: png, bodyBytes: png.length, contentType: "image/png" })).result, "pass");
  assert.equal(checkBinaryKind(base({ challengeDocument: qrDoc, bodyHead: "", bodyBytes: 0, contentType: "image/png" })).result, "not_checked");
  assert.equal(checkBinaryKind(base({ challengeDocument: qrDoc, bodyHead: "", bodyBytes: 0, contentType: "image/png" })).reason, "binary_empty");
  const jpeg = new TextDecoder().decode(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])).replaceAll("\u0000", "");
  const inexact = checkBinaryKind(base({ challengeDocument: qrDoc, bodyHead: jpeg, bodyBytes: 10, contentType: "image/jpeg" }));
  assert.equal(inexact.result, "not_checked");
  assert.equal(inexact.reason, "binary_kind_inexact");
  const pngExact = new TextDecoder().decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const wrong = checkBinaryKind(
    base({
      challengeDocument: { accepts: [{ outputSchema: { type: "string", contentMediaType: "image/jpeg" } }] },
      bodyHead: pngExact,
      bodyBytes: pngExact.length,
      contentType: "image/png",
    }),
  );
  assert.equal(wrong.result, "fail");
  assert.equal(wrong.reason, "binary_kind_mismatch");
});

test("binary_kind: 頭が文字列でない行は bodyBytes が正なら binary_empty の fail にせず not_checked", () => {
  const qrDoc = { accepts: [{ outputSchema: { type: "string", contentMediaType: "image/png" } }] };
  const v = checkBinaryKind(base({ challengeDocument: qrDoc, bodyHead: null as unknown as string, bodyBytes: 1200, contentType: "image/png" }));
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "bad_body_head");
});
test("input_echo: 送った数と数でない文字列の 5 例（単独の数・十進のみ・部分一致なし）", () => {
  const url = "https://example.com/x";
  const mk = (param: string, paramVal: string, body: string) => {
    const doc = { extensions: { bazaar: { info: { input: { queryParams: { [param]: paramVal } } } } } };
    const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
    const sha = createHash("sha256").update(query!, "utf8").digest("hex");
    return checkInputEcho(
      base({
        resourceUrl: url,
        challengeDocument: doc,
        requestQuery: "declared",
        requestQuerySha256: sha,
        bodyHead: body,
        bodyBytes: Buffer.byteLength(body),
      }),
    );
  };
  assert.equal(mk("size", "256", '{"size":"256x256"}').result, "pass");
  assert.equal(mk("w", "10", '{"w":"10px"}').result, "pass");
  assert.equal(mk("v", "2", '{"v":"2.5px"}').result, "not_checked");
  assert.equal(mk("n", "10", '{"n":"price is 100 yen"}').result, "not_checked");
  assert.equal(mk("n", "10", '{"n":"price is 100 yen"}').reason, "echo_not_confirmed");
  assert.equal(mk("size", "256", '{"size":"512x512"}').result, "not_checked");
});

test("input_echo: 送った数を含む数でない文字列（size=256 と \"256x256\"）は不一致にしない", () => {
  const doc = {
    extensions: { bazaar: { info: { input: { queryParams: { size: "256" } } } } },
  };
  const url = "https://example.com/x";
  const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
  const sha = createHash("sha256").update(query!, "utf8").digest("hex");
  const body = '{"size":"256x256"}';
  const ok = checkInputEcho(
    base({ resourceUrl: url, challengeDocument: doc, requestQuery: "declared", requestQuerySha256: sha, bodyHead: body, bodyBytes: Buffer.byteLength(body) }),
  );
  assert.equal(ok.result, "pass");
  const other = '{"size":"512x512"}';
  const bad = checkInputEcho(
    base({ resourceUrl: url, challengeDocument: doc, requestQuery: "declared", requestQuerySha256: sha, bodyHead: other, bodyBytes: Buffer.byteLength(other) }),
  );
  assert.equal(bad.result, "not_checked");
  assert.equal(bad.reason, "echo_not_confirmed");
});

test("shape_drift: constructor キー追加だけは same_shape pass", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json" });
  const m = checkShapeDrift([
    mk("co1", "2026-11-01T00:00:00Z", '{"a":1}', 7),
    mk("co2", "2026-11-02T00:00:00Z", '{"a":1,"constructor":"fn"}', 26),
  ]);
  assert.equal(m.get("co2")?.result, "pass");
  assert.equal(m.get("co2")?.reason, "same_shape");
});

test("shape_drift: __proto__ は自分のキーとして形に残る", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json" });
  const m = checkShapeDrift([
    mk("pr1", "2026-11-01T00:00:00Z", '{"a":1}', 7),
    mk("pr2", "2026-11-02T00:00:00Z", '{"a":1,"__proto__":{"x":1}}', 27),
  ]);
  assert.equal(m.get("pr2")?.result, "pass");
  assert.equal(m.get("pr2")?.reason, "same_shape");
  assert.ok((m.get("pr2")?.detail?.addedKeys as string[])?.includes("__proto__"));
});

test("shape_drift: bodyBytes と UTF-8 長が合わなくても 8 バイト PNG 頭は binary:png", () => {
  const pngHead = new TextDecoder().decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpegHead = new TextDecoder().decode(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
  assert.notEqual(Buffer.byteLength(pngHead, "utf8"), 8);
  const mk = (id: string, at: string, head: string) =>
    base({
      purchaseId: id,
      attemptedAt: at,
      bodyHead: head,
      bodyBytes: 8,
      contentType: "image/png",
      endpointKey: "bin-ep",
    });
  const m = checkShapeDrift([mk("bn1", "2026-11-01T00:00:00Z", pngHead), mk("bn2", "2026-11-02T00:00:00Z", jpegHead)]);
  assert.equal(m.get("bn1")?.reason, "baseline");
  assert.equal(m.get("bn2")?.result, "fail");
  assert.equal(m.get("bn2")?.reason, "shape_changed");
});

test("declared_type: 宣言に toString があって応答に無くても type_differs にしない", () => {
  const catalog = {
    properties: {
      output: {
        properties: {
          example: {
            properties: {
              label: { type: "string" },
              toString: { type: "string" },
            },
          },
        },
      },
    },
  };
  const v = checkDeclaredType(
    base({
      catalogDeclaredSchema: catalog,
      bodyHead: '{"label":"ok"}',
      bodyBytes: 14,
    }),
  );
  assert.equal(v.result, "pass");
});

test("input_echo: 不一致は fail にせず echo_not_confirmed", () => {
  const url = "https://example.com/x";
  const mkQ = (params: Record<string, string>, body: string) => {
    const doc = { extensions: { bazaar: { info: { input: { queryParams: params } } } } };
    const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: doc });
    const sha = createHash("sha256").update(query!, "utf8").digest("hex");
    return checkInputEcho(
      base({
        resourceUrl: url,
        challengeDocument: doc,
        requestQuery: "declared",
        requestQuerySha256: sha,
        bodyHead: body,
        bodyBytes: Buffer.byteLength(body),
      }),
    );
  };
  const rawBool = mkQ({ raw: "1" }, '{"raw":true}');
  assert.notEqual(rawBool.result, "fail");
  for (const v of [
    mkQ({ n: "1000" }, '{"n":"1,000"}'),
    mkQ({ v: "2.5" }, '{"v":3}'),
    mkQ({ size: "1024" }, '{"size":"1KB"}'),
    mkQ({ lang: "ja" }, '{"lang":"Japanese"}'),
  ]) {
    assert.notEqual(v.result, "fail");
    if (v.result === "not_checked") assert.equal(v.reason, "echo_not_confirmed");
  }
  const limitBody = '{"limit":7}';
  const limitDoc = { extensions: { bazaar: { info: { input: { queryParams: { limit: "10" } } } } } };
  const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: limitDoc });
  const sha = createHash("sha256").update(query!, "utf8").digest("hex");
  const limitV = checkInputEcho(
    base({
      resourceUrl: url,
      challengeDocument: limitDoc,
      requestQuery: "declared",
      requestQuerySha256: sha,
      bodyHead: limitBody,
      bodyBytes: Buffer.byteLength(limitBody),
    }),
  );
  assert.equal(limitV.result, "not_checked");
  assert.equal(limitV.reason, "echo_not_confirmed");
  for (const v of [mkQ({ raw: "1" }, '{"raw":true}'), mkQ({ n: "1000" }, '{"n":"1,000"}')]) {
    assert.notEqual(v.result, "fail");
  }
});

test("shape_drift: 失敗っぽい本文と動的キーは not_applicable", () => {
  const mk = (id: string, at: string, body: string, bytes: number) =>
    base({ purchaseId: id, attemptedAt: at, bodyHead: body, bodyBytes: bytes, contentType: "application/json" });
  const err = checkShapeDrift([mk("e1", "2026-11-01T00:00:00Z", '{"error":"x"}', 13)]);
  assert.equal(err.get("e1")?.reason, "failure_like_body");
  const dynBody = '{"2026-01-01":1,"2026-01-02":2,"x":3}';
  const dyn = checkShapeDrift([
    mk("d1", "2026-11-01T00:00:00Z", dynBody, Buffer.byteLength(dynBody)),
    mk("d2", "2026-11-02T00:00:00Z", '{"2026-01-03":4}', 18),
  ]);
  assert.equal(dyn.get("d1")?.reason, "dynamic_keys");
});

test("runAnswerChecks: fail を出せる判定器は json_valid・declared_type・binary_kind のみ", () => {
  const qrDoc = { accepts: [{ outputSchema: { type: "string", contentMediaType: "image/png" } }] };
  const jpegDoc = { accepts: [{ outputSchema: { type: "string", contentMediaType: "image/jpeg" } }] };
  const typeCatalog = {
    properties: {
      output: { properties: { example: { properties: { price: { type: "number" } } } } },
    },
  };
  const png = new TextDecoder().decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpegText = new TextDecoder().decode(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])).replaceAll("\u0000", "");
  const mp3 = new TextDecoder().decode(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x10]));
  const url = "https://example.com/x";
  const echoDoc = { extensions: { bazaar: { info: { input: { queryParams: { q: "1" } } } } } };
  const { query } = declaredRequestUrlFromDoc({ resourceUrl: url, document: echoDoc });
  const echoSha = createHash("sha256").update(query!, "utf8").digest("hex");
  const rows: StoredAnswer[] = [
    base({ purchaseId: "j1", bodyHead: "{bad", bodyBytes: 4, contentType: "application/json" }),
    base({ purchaseId: "j2", bodyHead: "{bad", bodyBytes: 4, contentType: "text/plain" }),
    base({ purchaseId: "h1", bodyHead: "<html></html>", bodyBytes: 13, contentType: "text/html" }),
    base({ purchaseId: "e1", bodyHead: "", bodyBytes: 0, contentType: "application/json" }),
    base({ purchaseId: "b1", challengeDocument: qrDoc, bodyHead: png, bodyBytes: png.length, contentType: "image/png" }),
    base({ purchaseId: "b2", challengeDocument: jpegDoc, bodyHead: jpegText, bodyBytes: jpegText.length, contentType: "image/jpeg" }),
    base({ purchaseId: "b3", challengeDocument: qrDoc, bodyHead: mp3, bodyBytes: mp3.length, contentType: "audio/mpeg" }),
    base({ purchaseId: "b4", challengeDocument: jpegDoc, bodyHead: png, bodyBytes: png.length, contentType: "image/png" }),
    base({ purchaseId: "err1", bodyHead: '{"error":"x"}', bodyBytes: 13 }),
    base({
      purchaseId: "echo1",
      resourceUrl: url,
      challengeDocument: echoDoc,
      requestQuery: "declared",
      requestQuerySha256: echoSha,
      bodyHead: '{"q":"2"}',
      bodyBytes: 9,
    }),
    base({
      purchaseId: "dt1",
      catalogDeclaredSchema: typeCatalog,
      bodyHead: '{"price":"x"}',
      bodyBytes: 13,
    }),
    base({ purchaseId: "sd1", endpointKey: "ep-shape", attemptedAt: "2026-11-01T00:00:00Z", bodyHead: '{"a":1}', bodyBytes: 7 }),
    base({ purchaseId: "sd2", endpointKey: "ep-shape", attemptedAt: "2026-11-02T00:00:00Z", bodyHead: '{"a":1,"b":2}', bodyBytes: 13 }),
    base({ purchaseId: "dk1", bodyHead: '{"2026-11-01":1,"2026-11-02":2,"z":1}', bodyBytes: 33 }),
  ];
  const all = runAnswerChecks(rows);
  for (const [pid, verdicts] of all) {
    const fails = verdicts.filter((v) => v.result === "fail");
    assert.ok(fails.every((v) => v.check === "json_valid" || v.check === "declared_type" || v.check === "binary_kind"));
    for (const f of fails.filter((v) => v.check === "binary_kind")) {
      assert.equal(f.reason, "binary_kind_mismatch");
      assert.equal(f.detail?.exact, true);
    }
    for (const f of fails.filter((v) => v.check === "json_valid")) {
      const row = rows.find((r) => r.purchaseId === pid)!;
      assert.ok((row.contentType ?? "").toLowerCase().includes("json"));
    }
    assert.ok(!verdicts.some((v) => v.check === "input_echo" && v.result === "fail"));
    const shapeFail = verdicts.find((v) => v.check === "shape_drift" && v.result === "fail");
    if (shapeFail) {
      assert.equal(shapeFail.reason, "shape_changed");
    }
  }
  const j2 = all.get("j2")!.find((v) => v.check === "json_valid")!;
  assert.notEqual(j2.result, "fail");
});

test("declared_type: 見本の値と型が違っても fail にしない（見本は型の宣言ではない）", () => {
  const catalog = { properties: { output: { properties: { example: { properties: { id: "123", n: 1 } } } } } };
  const v = checkDeclaredType(base({ catalogDeclaredSchema: catalog, bodyHead: '{"id":123,"n":"1"}', bodyBytes: 18 }));
  assert.notEqual(v.result, "fail");
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "example_type_differs");
});

test("json_valid: fail は Content-Type が application/json か +json のときだけ（正しい NDJSON・jsonl・json-seq は not_checked）", () => {
  const ndjson = '{"a":1}\n{"a":2}\n';
  for (const ct of ["application/x-ndjson", "application/jsonl", "application/json-seq", "application/x-ndjson; charset=utf-8"]) {
    const v = checkJsonValid(base({ contentType: ct, bodyHead: ndjson, bodyBytes: Buffer.byteLength(ndjson) }));
    assert.equal(v.result, "not_checked", ct);
    assert.equal(v.reason, "not_single_json_content_type");
  }
  assert.equal(checkJsonValid(base({ contentType: "application/problem+json", bodyHead: "{bad", bodyBytes: 4 })).result, "fail");
  assert.equal(checkJsonValid(base({ contentType: "application/json; charset=utf-8", bodyHead: "{bad", bodyBytes: 4 })).result, "fail");
});

test("declared_type: 見本の値が JSON Schema の語だけでできていても型の宣言とみなさず、見本どおりの応答を fail にしない", () => {
  // 402 の output.example（見本）。値 {"type":"string"} は見本の値であって型の宣言ではない。
  const doc = { extensions: { bazaar: { info: { output: { example: { mode: { type: "string" }, n: 1 } } } } } };
  const body = '{"mode":{"type":"string"},"n":1}';
  const v = checkDeclaredType(base({ challengeDocument: doc, catalogDeclaredSchema: null, bodyHead: body, bodyBytes: Buffer.byteLength(body) }));
  assert.notEqual(v.result, "fail");
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "example_type_differs");
});

test("declared_type: bodyBytes が null の行は not_checked（body_length_unknown）", () => {
  const catalog = { properties: { output: { properties: { example: { properties: { id: { type: "integer" } } } } } } };
  const v = checkDeclaredType(base({ catalogDeclaredSchema: catalog, bodyHead: '{"id":"x"}', bodyBytes: null }));
  assert.equal(v.result, "not_checked");
  assert.equal(v.reason, "body_length_unknown");
  // 長さの記録があり、スキーマの型と違えば今までどおり fail。
  assert.equal(checkDeclaredType(base({ catalogDeclaredSchema: catalog, bodyHead: '{"id":"x"}', bodyBytes: 10 })).result, "fail");
});
