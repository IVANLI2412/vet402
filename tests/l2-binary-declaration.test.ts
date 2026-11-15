// Run: npx tsx --test tests/l2-binary-declaration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  binaryKindOfBytes,
  binaryKindOfDecodedText,
  binaryMediaTypeFromDocument,
  checkL2Binary,
  checkL2Detailed,
  checkL2WithBinaryDeclaration,
  liveBinaryMediaTypeOf,
  liveOutputExampleOf,
  liveOutputSchemaOf,
} from "@/lib/observatory/l2-check";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_JFIF = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_DQT = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);

const qrDoc = {
  accepts: [{ outputSchema: { type: "string", contentMediaType: "image/png" } }],
  extensions: {
    bazaar: {
      info: { output: { type: "binary", example: "(raw image/png bytes, not JSON)" } },
      schema: {
        properties: {
          output: {
            // 実測 11/15 の 402 の extensions.bazaar.schema.properties.output と同じ形。
            type: "object",
            properties: { type: { type: "string" }, example: { type: "string", contentMediaType: "image/png" } },
            required: ["type"],
          },
        },
      },
    },
  },
  resource: { mimeType: "image/png" },
};

const imageConvertDoc = {
  accepts: [{ outputSchema: { type: "string", contentMediaType: "image/jpeg" } }],
  extensions: {
    bazaar: {
      info: { output: { type: "binary", example: "(raw image/jpeg bytes, not JSON; other formats answer image/png, image/bmp)" } },
      schema: {
        properties: {
          output: {
            // 実測 11/15 の 402 の extensions.bazaar.schema.properties.output と同じ形。
            type: "object",
            properties: { type: { type: "string" }, example: { type: "string", contentMediaType: "image/jpeg" } },
            required: ["type"],
          },
        },
      },
    },
  },
  resource: { mimeType: "image/jpeg" },
};

const jsonDeclaredCatalog = {
  properties: {
    output: {
      properties: {
        example: { required: ["symbol"], properties: { symbol: { type: "string" } } },
      },
    },
  },
};

function pngText(): string {
  return new TextDecoder().decode(PNG_BYTES);
}

function pngTextNoNul(): string {
  return pngText().replace(/\u0000/g, "");
}

test("agent402 /api/qr の 402 から liveBinaryMediaTypeOf が image/png（ヘッダと本文）", () => {
  const body = JSON.stringify(qrDoc);
  assert.equal(liveBinaryMediaTypeOf({ bodyText: body, headers: new Headers() }), "image/png");
  const b64 = Buffer.from(body, "utf8").toString("base64");
  assert.equal(
    liveBinaryMediaTypeOf({ bodyText: "", headers: new Headers({ "payment-required": b64 }) }),
    "image/png",
  );
});

test("image-convert の形から liveBinaryMediaTypeOf が image/jpeg", () => {
  assert.equal(liveBinaryMediaTypeOf({ bodyText: JSON.stringify(imageConvertDoc), headers: new Headers() }), "image/jpeg");
});

test("同じ入力で checkL2Detailed は no_declaration のまま", () => {
  const body = pngText();
  const d = checkL2Detailed(null, body, "image/png");
  assert.equal(d.status, "no_declaration");
});

test("qr 形＋PNG バイトと直した文字列で match", () => {
  const mt = binaryMediaTypeFromDocument(qrDoc)!;
  for (const body of [PNG_BYTES, pngText(), pngTextNoNul()] as const) {
    const r = checkL2WithBinaryDeclaration(null, typeof body === "string" ? body : pngText(), "image/png", null, null, null, mt);
    assert.equal(r.status, "match");
  }
  const bin = checkL2Binary({ mediaType: "image/png", body: PNG_BYTES, contentType: "image/png" });
  assert.equal(bin.status, "match");
});

test("image-convert 形: 生バイト JPEG は match、直した文字列は not_checked", () => {
  const mt = "image/jpeg";
  for (const bytes of [JPEG_JFIF, JPEG_DQT]) {
    const text = new TextDecoder().decode(bytes);
    assert.equal(checkL2Binary({ mediaType: mt, body: bytes, contentType: "image/jpeg" }).status, "match");
    assert.equal(checkL2WithBinaryDeclaration(null, text, "image/jpeg", null, null, null, mt).status, "not_checked");
    assert.equal(checkL2WithBinaryDeclaration(null, text.replaceAll("\u0000", ""), "image/jpeg", null, null, null, mt).status, "not_checked");
    assert.equal(checkL2WithBinaryDeclaration(null, text.replaceAll("\u0000", ""), "image/jpeg", null, null, null, mt).reason, "binary_kind_inexact");
  }
});

test("image/jpeg 宣言＋PNG は mismatch、image/png 宣言＋JPEG も mismatch", () => {
  assert.equal(checkL2Binary({ mediaType: "image/jpeg", body: PNG_BYTES, contentType: "image/png" }).reason, "binary_kind_mismatch");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: JPEG_JFIF, contentType: "image/jpeg" }).reason, "binary_kind_mismatch");
});

test("空本文は binary_empty で not_checked", () => {
  const r = checkL2Binary({ mediaType: "image/png", body: "", contentType: "image/png" });
  assert.equal(r.status, "not_checked");
  assert.equal(r.reason, "binary_empty");
});

test("空白だけの本文も binary_empty not_checked（文字列とバイト）", () => {
  assert.equal(checkL2Binary({ mediaType: "image/png", body: "   \n\t", contentType: "image/png" }).status, "not_checked");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: "   \n\t", contentType: "image/png" }).reason, "binary_empty");
  const ws = new Uint8Array([0x20, 0x09, 0x0a, 0x0d, 0x20]);
  assert.equal(checkL2Binary({ mediaType: "image/png", body: ws, contentType: "image/png" }).reason, "binary_empty");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: ws, contentType: "image/png" }).status, "not_checked");
});

test("octet-stream でも空白だけの本文は not_checked binary_empty", () => {
  const r = checkL2Binary({ mediaType: "application/octet-stream", body: "  ", contentType: null });
  assert.equal(r.status, "not_checked");
  assert.equal(r.reason, "binary_empty");
});

test("ヘッダの 402 に媒体型が無くても本文の 402 から liveBinaryMediaTypeOf が取れる", () => {
  const body = JSON.stringify(qrDoc);
  const headerOnly = JSON.stringify({ accepts: [{ outputSchema: { type: "string" } }] });
  const b64 = Buffer.from(headerOnly, "utf8").toString("base64");
  assert.equal(
    liveBinaryMediaTypeOf({ bodyText: body, headers: new Headers({ "payment-required": b64 }) }),
    "image/png",
  );
});

test("image/png 宣言＋JSON または HTML は binary_text_body not_checked", () => {
  assert.equal(checkL2Binary({ mediaType: "image/png", body: '{"error":"rate limited"}', contentType: "image/png" }).status, "not_checked");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: '{"error":"rate limited"}', contentType: "image/png" }).reason, "binary_text_body");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: "<html>x</html>", contentType: "text/html" }).status, "not_checked");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: "<html>x</html>", contentType: "text/html" }).reason, "binary_text_body");
});

test("GIF・WebP・PDF の検出と image/* と octet-stream", () => {
  const gif = new TextEncoder().encode("GIF89a\x00\x00");
  assert.equal(binaryKindOfBytes(gif), "gif");
  const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0xff, 0xfe, 0x00, 0x00, ...new TextEncoder().encode("WEBP")]);
  assert.equal(binaryKindOfBytes(webp), "webp");
  const pdf = new TextEncoder().encode("%PDF-1.4");
  assert.equal(binaryKindOfBytes(pdf), "pdf");
  assert.equal(checkL2Binary({ mediaType: "image/*", body: PNG_BYTES, contentType: "image/png" }).status, "match");
  // image/* は特定の型ではないので、exact な PDF でも mismatch にせず not_checked。
  assert.equal(checkL2Binary({ mediaType: "image/*", body: pdf, contentType: "application/pdf" }).status, "not_checked");
  const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  assert.equal(checkL2Binary({ mediaType: "application/octet-stream", body: unknown, contentType: null }).status, "not_checked");
  assert.equal(checkL2Binary({ mediaType: "application/octet-stream", body: unknown, contentType: null }).reason, "binary_kind_unknown");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: unknown, contentType: null }).status, "not_checked");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: unknown, contentType: null }).reason, "binary_kind_unknown");
});

test("body_over_cap の PNG は判定する。body_timeout は not_checked", () => {
  assert.equal(checkL2Binary({ mediaType: "image/png", body: PNG_BYTES, contentType: "image/png", bodyIncomplete: "body_over_cap" }).status, "match");
  assert.equal(checkL2Binary({ mediaType: "image/png", body: PNG_BYTES, contentType: "image/png", bodyIncomplete: "body_timeout" }).status, "not_checked");
});

test("JSON 必須キー宣言がある掲載では checkL2WithBinaryDeclaration は checkL2Detailed と同じ", () => {
  const body = '{"symbol":"BTC"}';
  const detailed = checkL2Detailed(jsonDeclaredCatalog, body, "application/json", null, null, null);
  const withBin = checkL2WithBinaryDeclaration(jsonDeclaredCatalog, body, "application/json", null, null, null, "image/png");
  const { binary: _b, ...rest } = withBin;
  assert.deepEqual(rest, detailed);
  assert.equal(_b, undefined);
});

test("image/bmp は対応外で no_declaration のまま", () => {
  const bmpDoc = { accepts: [{ outputSchema: { type: "string", contentMediaType: "image/bmp" } }] };
  assert.equal(binaryMediaTypeFromDocument(bmpDoc), null);
  assert.equal(
    checkL2WithBinaryDeclaration(null, "BM...", "image/bmp", null, null, null, "image/bmp").status,
    "no_declaration",
  );
});

test("binaryKindOfDecodedText は JPEG を exact false で返す", () => {
  const j = binaryKindOfDecodedText(new TextDecoder().decode(JPEG_JFIF));
  assert.equal(j?.kind, "jpeg");
  assert.equal(j?.exact, false);
});

test("置換文字3つ＋HTML は jpeg と見なさず binary_text_body not_checked", () => {
  const body = "\uFFFD\uFFFD\uFFFD<html>x</html>";
  assert.equal(binaryKindOfDecodedText(body), null);
  assert.equal(checkL2Binary({ mediaType: "image/jpeg", body, contentType: "image/jpeg" }).status, "not_checked");
  assert.equal(checkL2Binary({ mediaType: "image/jpeg", body, contentType: "image/jpeg" }).reason, "binary_text_body");
});

test("直した文字列の JPEG（JFIF・DQT）は not_checked binary_kind_inexact", () => {
  for (const bytes of [JPEG_JFIF, JPEG_DQT]) {
    const text = new TextDecoder().decode(bytes);
    assert.equal(checkL2Binary({ mediaType: "image/jpeg", body: text, contentType: "image/jpeg" }).status, "not_checked");
    assert.equal(checkL2Binary({ mediaType: "image/jpeg", body: text, contentType: "image/jpeg" }).reason, "binary_kind_inexact");
    assert.equal(checkL2Binary({ mediaType: "image/png", body: text, contentType: "image/jpeg" }).status, "not_checked");
    assert.equal(checkL2Binary({ mediaType: "image/png", body: text, contentType: "image/jpeg" }).reason, "binary_kind_inexact");
  }
});

test("MP3・UTF-16 BOM・任意バイト列は jpeg/png 宣言でも not_checked", () => {
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
  const mp3Text = new TextDecoder().decode(mp3);
  const utf16Le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
  const utf16Be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
  const arbitrary = [new Uint8Array([0x00, 0x01, 0x02, 0x03]), new Uint8Array([0xff, 0xff, 0xff, 0xff])];
  for (const mt of ["image/jpeg", "image/png"] as const) {
    for (const body of [mp3, mp3Text, utf16Le, utf16Be, ...arbitrary] as const) {
      const r = checkL2Binary({ mediaType: mt, body, contentType: mt });
      assert.notEqual(r.status, "match");
      assert.notEqual(r.status, "mismatch");
      assert.equal(r.status, "not_checked");
    }
  }
});

test("生バイトの JPEG と image/jpeg は match、生バイト PNG と image/jpeg は mismatch", () => {
  assert.equal(checkL2Binary({ mediaType: "image/jpeg", body: JPEG_JFIF, contentType: "image/jpeg" }).status, "match");
  assert.equal(checkL2Binary({ mediaType: "image/jpeg", body: PNG_BYTES, contentType: "image/png" }).status, "mismatch");
  const pngText = pngTextNoNul();
  assert.equal(checkL2Binary({ mediaType: "image/jpeg", body: pngText, contentType: "image/png" }).status, "mismatch");
});
test("agent402 の実際の流れ: qr は PNG 直し文字列も match、image-convert は生 JPEG のみ match・直し JPEG は not_checked", () => {
  const catalog = qrDoc.extensions.bazaar.schema;
  const qrInput = { bodyText: JSON.stringify(qrDoc), headers: new Headers() };
  const qrEx = liveOutputExampleOf(qrInput);
  const qrSchema = liveOutputSchemaOf(qrInput);
  const qrMt = liveBinaryMediaTypeOf(qrInput);
  const qrGoodText = pngTextNoNul();
  const qrBadText = new TextDecoder().decode(JPEG_JFIF).replaceAll("\u0000", "");
  assert.equal(checkL2WithBinaryDeclaration(catalog, qrGoodText, "image/png", null, qrEx, qrSchema, qrMt).status, "match");
  const qrWrong = checkL2WithBinaryDeclaration(catalog, qrBadText, "image/png", null, qrEx, qrSchema, qrMt);
  assert.equal(qrWrong.status, "not_checked");
  assert.equal(qrWrong.reason, "binary_kind_inexact");
  const qrEmpty = checkL2WithBinaryDeclaration(catalog, "", "image/png", null, qrEx, qrSchema, qrMt);
  assert.equal(qrEmpty.status, "not_checked");
  assert.equal(qrEmpty.reason, "binary_empty");

  const icCatalog = imageConvertDoc.extensions.bazaar.schema;
  const icInput = { bodyText: JSON.stringify(imageConvertDoc), headers: new Headers() };
  const icEx = liveOutputExampleOf(icInput);
  const icSchema = liveOutputSchemaOf(icInput);
  const icMt = liveBinaryMediaTypeOf(icInput);
  assert.equal(checkL2Binary({ mediaType: icMt!, body: JPEG_DQT, contentType: "image/jpeg" }).status, "match");
  const icRawText = new TextDecoder().decode(JPEG_DQT);
  assert.equal(checkL2WithBinaryDeclaration(icCatalog, icRawText, "image/jpeg", null, icEx, icSchema, icMt).status, "not_checked");
  const icDecodedText = icRawText.replaceAll("\u0000", "");
  assert.equal(checkL2WithBinaryDeclaration(icCatalog, icDecodedText, "image/jpeg", null, icEx, icSchema, icMt).status, "not_checked");
  assert.equal(checkL2WithBinaryDeclaration(icCatalog, icDecodedText, "image/jpeg", null, icEx, icSchema, icMt).reason, "binary_kind_inexact");
  const icWrong = checkL2WithBinaryDeclaration(icCatalog, pngTextNoNul(), "image/jpeg", null, icEx, icSchema, icMt);
  assert.equal(icWrong.status, "mismatch");
  assert.equal(icWrong.reason, "binary_kind_mismatch");
});

test("WebP の長さに非 ASCII と U+0000 を含んでも、直した文字列と U+0000 を消した文字列で webp と読む", () => {
  const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0xff, 0xfe, 0x00, 0x00, ...new TextEncoder().encode("WEBPVP8 ")]);
  const text = new TextDecoder().decode(webp);
  assert.equal(binaryKindOfDecodedText(text)?.kind, "webp");
  assert.equal(binaryKindOfDecodedText(text.replaceAll("\u0000", ""))?.kind, "webp");
  assert.equal(checkL2Binary({ mediaType: "image/webp", body: text, contentType: "image/webp" }).status, "match");
});
