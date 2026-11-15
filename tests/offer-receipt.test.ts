// ============================================================
// offer-and-receipt 拡張: PAYMENT-RESPONSE 捕捉と記録用チェック
// Run: env -u DATABASE_URL npx tsx --test tests/offer-receipt.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  concat,
  encodeAbiParameters,
  hashStruct,
  hashTypedData,
  keccak256,
  recoverAddress,
  toBytes,
  toHex,
  type Hex,
} from "viem";
import { parseSettlementResponse } from "@/lib/observatory/x402-payer";
import {
  OFFER_RECEIPT_RAW_CAP_BYTES,
  RECEIPT_EIP712_DOMAIN,
  RECEIPT_EIP712_TYPES,
  checkOfferReceipt,
  captureOfferReceiptExtension,
} from "@/lib/observatory/offer-receipt";

const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const KNOWN_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RESOURCE = "https://api.example.com/premium-data";
const TX = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const offerReceiptExtV2 = {
  info: {
    receipt: {
      format: "eip712",
      payload: {
        version: 1,
        network: "eip155:8453",
        resourceUrl: RESOURCE,
        payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        issuedAt: 1703123456,
        transaction: "",
      },
      signature: "0x1234567890abcdef",
    },
  },
};

function headerFromBody(body: Record<string, unknown>, headerName = "PAYMENT-RESPONSE"): Headers {
  const h = new Headers();
  h.set(headerName, Buffer.from(JSON.stringify(body)).toString("base64"));
  return h;
}

function baseSettlement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    transaction: TX,
    network: "eip155:8453",
    payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    ...overrides,
  };
}

const baseFive = {
  success: true,
  transaction: TX,
  network: "eip155:8453",
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  errorReason: null,
};

async function signReceiptPayload(
  payload: {
    version: number;
    network: string;
    resourceUrl: string;
    payer: string;
    issuedAt: number;
    transaction: string;
  },
): Promise<Hex> {
  const account = privateKeyToAccount(KNOWN_PK);
  return account.signTypedData({
    domain: RECEIPT_EIP712_DOMAIN,
    types: RECEIPT_EIP712_TYPES,
    primaryType: "Receipt",
    message: {
      version: BigInt(payload.version),
      network: payload.network,
      resourceUrl: payload.resourceUrl,
      payer: payload.payer,
      issuedAt: BigInt(payload.issuedAt),
      transaction: payload.transaction,
    },
  });
}

test("§6.5 v2 PAYMENT-RESPONSE: 5 欄は同じ・offerReceipt.raw が deepEqual", () => {
  const body = {
    ...baseSettlement(),
    extensions: { "offer-receipt": offerReceiptExtV2 },
  };
  const r = parseSettlementResponse(headerFromBody(body));
  assert.deepEqual(
    {
      success: r?.success,
      transaction: r?.transaction,
      network: r?.network,
      payer: r?.payer,
      errorReason: r?.errorReason,
    },
    baseFive,
  );
  assert.ok(r?.offerReceipt && "raw" in r.offerReceipt);
  assert.deepEqual(r.offerReceipt.raw, offerReceiptExtV2);
  const bytes = Buffer.byteLength(JSON.stringify(offerReceiptExtV2), "utf8");
  assert.equal(r.offerReceipt.bytes, bytes);
});

test("§6.6 v1 X-PAYMENT-RESPONSE・network base でも同じ", () => {
  const body = {
    success: true,
    transaction: TX,
    network: "base",
    payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    extensions: { "offer-receipt": offerReceiptExtV2 },
  };
  const r = parseSettlementResponse(headerFromBody(body, "X-PAYMENT-RESPONSE"));
  assert.deepEqual(
    {
      success: r?.success,
      transaction: r?.transaction,
      network: r?.network,
      payer: r?.payer,
      errorReason: r?.errorReason,
    },
    { ...baseFive, network: "base" },
  );
  assert.ok(r?.offerReceipt && "raw" in r.offerReceipt);
  assert.deepEqual(r.offerReceipt.raw, offerReceiptExtV2);
});

test("ヘッダ無し・壊れた base64・壊れた JSON・不正 extensions は 5 欄だけ", () => {
  assert.equal(parseSettlementResponse(new Headers()), null);
  const badB64 = new Headers({ "PAYMENT-RESPONSE": "!!!" });
  assert.equal(parseSettlementResponse(badB64), null);
  const badJson = new Headers({
    "PAYMENT-RESPONSE": Buffer.from("not-json").toString("base64"),
  });
  assert.equal(parseSettlementResponse(badJson), null);

  const noExt = parseSettlementResponse(headerFromBody(baseSettlement()));
  assert.deepEqual(noExt, baseFive);

  const extString = parseSettlementResponse(
    headerFromBody({ ...baseSettlement(), extensions: "x" }),
  );
  assert.deepEqual(extString, baseFive);
  assert.equal("offerReceipt" in (extString ?? {}), false);

  const orArray = parseSettlementResponse(
    headerFromBody({ ...baseSettlement(), extensions: { "offer-receipt": [] } }),
  );
  assert.deepEqual(orArray, baseFive);
  assert.equal("offerReceipt" in (orArray ?? {}), false);

  const orString = parseSettlementResponse(
    headerFromBody({ ...baseSettlement(), extensions: { "offer-receipt": "x" } }),
  );
  assert.deepEqual(orString, baseFive);

  const receiptArray = parseSettlementResponse(
    headerFromBody({
      ...baseSettlement(),
      extensions: { "offer-receipt": { info: { receipt: [] } } },
    }),
  );
  assert.ok(receiptArray?.offerReceipt);
});

test("8192 超は overCap・ちょうど 8192 は raw 残る", () => {
  let pad = "x";
  let ext: Record<string, unknown>;
  for (;;) {
    ext = { info: { offers: [], pad } };
    const bytes = Buffer.byteLength(JSON.stringify(ext), "utf8");
    if (bytes > OFFER_RECEIPT_RAW_CAP_BYTES) break;
    pad += "x";
  }
  const over = captureOfferReceiptExtension({ "offer-receipt": ext });
  assert.ok(over && "overCap" in over && over.overCap);
  assert.equal("raw" in (over ?? {}), false);

  pad = "";
  for (;;) {
    ext = { info: { offers: [], pad } };
    const bytes = Buffer.byteLength(JSON.stringify(ext), "utf8");
    if (bytes === OFFER_RECEIPT_RAW_CAP_BYTES) break;
    if (bytes > OFFER_RECEIPT_RAW_CAP_BYTES) {
      pad = pad.slice(0, -1);
      ext = { info: { offers: [], pad } };
      break;
    }
    pad += "a";
  }
  const exact = captureOfferReceiptExtension({ "offer-receipt": ext });
  assert.ok(exact && "raw" in exact);
  assert.equal(exact.bytes, OFFER_RECEIPT_RAW_CAP_BYTES);
});

test("既知鍵で署名した eip712 receipt は recovered・3 つ match", async () => {
  const payload = {
    version: 1,
    network: "eip155:8453",
    resourceUrl: RESOURCE,
    payer: KNOWN_ADDR,
    issuedAt: 1703123456,
    transaction: "",
  };
  const signature = await signReceiptPayload(payload);
  const raw = {
    info: {
      receipt: { format: "eip712", payload, signature },
    },
  };
  const check = await checkOfferReceipt(raw, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.equal(check.receipt, "present");
  if (check.receipt !== "present") return;
  assert.equal(check.signature, "recovered");
  assert.equal(check.signer, KNOWN_ADDR);
  assert.equal(check.resourceUrl, "match");
  assert.equal(check.payer, "match");
  assert.equal(check.network, "match");
});

test("EIP-712 digest を手組みすると hashTypedData と一致し復元できる", async () => {
  const payload = {
    version: 1,
    network: "eip155:8453",
    resourceUrl: RESOURCE,
    payer: KNOWN_ADDR,
    issuedAt: 1703123456,
    transaction: "",
  };
  const signature = await signReceiptPayload(payload);
  const typedHash = hashTypedData({
    domain: RECEIPT_EIP712_DOMAIN,
    types: RECEIPT_EIP712_TYPES,
    primaryType: "Receipt",
    message: {
      version: BigInt(payload.version),
      network: payload.network,
      resourceUrl: payload.resourceUrl,
      payer: payload.payer,
      issuedAt: BigInt(payload.issuedAt),
      transaction: payload.transaction,
    },
  });
  const typeStr =
    "Receipt(uint256 version,string network,string resourceUrl,string payer,uint256 issuedAt,string transaction)";
  const receiptTypeHash = keccak256(toBytes(typeStr));
  const domainTypeHash = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId)"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [
        domainTypeHash,
        keccak256(toBytes("x402 receipt")),
        keccak256(toBytes("1")),
        1n,
      ],
    ),
  );
  const structHash = hashStruct({
    data: {
      version: BigInt(payload.version),
      network: payload.network,
      resourceUrl: payload.resourceUrl,
      payer: payload.payer,
      issuedAt: BigInt(payload.issuedAt),
      transaction: payload.transaction,
    },
    primaryType: "Receipt",
    types: RECEIPT_EIP712_TYPES,
  });
  const structEncoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [
      receiptTypeHash,
      1n,
      keccak256(toHex(payload.network)),
      keccak256(toHex(payload.resourceUrl)),
      keccak256(toHex(payload.payer)),
      BigInt(payload.issuedAt),
      keccak256(toHex(payload.transaction)),
    ],
  );
  assert.equal(structHash, keccak256(structEncoded));
  const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
  assert.equal(digest, typedHash);
  const recovered = await recoverAddress({ hash: digest, signature });
  assert.equal(recovered, KNOWN_ADDR);
});

test("transaction を抜いた payload でも recovered", async () => {
  const payload = {
    version: 1,
    network: "eip155:8453",
    resourceUrl: RESOURCE,
    payer: KNOWN_ADDR,
    issuedAt: 1703123456,
  };
  const signed = await privateKeyToAccount(KNOWN_PK).signTypedData({
    domain: RECEIPT_EIP712_DOMAIN,
    types: RECEIPT_EIP712_TYPES,
    primaryType: "Receipt",
    message: {
      version: 1n,
      network: payload.network,
      resourceUrl: payload.resourceUrl,
      payer: payload.payer,
      issuedAt: BigInt(payload.issuedAt),
      transaction: "",
    },
  });
  const raw = {
    info: {
      receipt: {
        format: "eip712",
        payload,
        signature: signed,
      },
    },
  };
  const check = await checkOfferReceipt(raw, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.equal(check.receipt, "present");
  if (check.receipt !== "present") return;
  assert.equal(check.signature, "recovered");
  assert.equal(check.signer, KNOWN_ADDR);
});

test("payload の不一致は mismatch・query だけ違う URL は match_path", async () => {
  const payload = {
    version: 1,
    network: "eip155:8453",
    resourceUrl: RESOURCE,
    payer: KNOWN_ADDR,
    issuedAt: 1703123456,
    transaction: "",
  };
  const signature = await signReceiptPayload(payload);

  const wrongPayer = {
    info: {
      receipt: {
        format: "eip712",
        payload: { ...payload, payer: "0x1111111111111111111111111111111111111111" },
        signature,
      },
    },
  };
  const cp = await checkOfferReceipt(wrongPayer, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.equal(cp.receipt, "present");
  if (cp.receipt !== "present") return;
  assert.equal(cp.signature, "recovered");
  assert.notEqual(cp.signer, KNOWN_ADDR);
  assert.equal(cp.payer, "mismatch");

  const wrongNet = {
    info: {
      receipt: {
        format: "eip712",
        payload: { ...payload, network: "eip155:1" },
        signature,
      },
    },
  };
  const cn = await checkOfferReceipt(wrongNet, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.ok(cn.receipt === "present");
  assert.equal(cn.network, "mismatch");

  const wrongUrl = {
    info: {
      receipt: {
        format: "eip712",
        payload: { ...payload, resourceUrl: "https://other.example/path" },
        signature,
      },
    },
  };
  const cu = await checkOfferReceipt(wrongUrl, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.ok(cu.receipt === "present");
  assert.equal(cu.resourceUrl, "mismatch");

  const pathOnly = {
    info: {
      receipt: {
        format: "eip712",
        payload: { ...payload, resourceUrl: `${RESOURCE}?q=1` },
        signature: await signReceiptPayload({ ...payload, resourceUrl: `${RESOURCE}?q=1` }),
      },
    },
  };
  const cpath = await checkOfferReceipt(pathOnly, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.ok(cpath.receipt === "present");
  assert.equal(cpath.resourceUrl, "match_path");
});

test("jws: 署名は確かめない・payload で 3 つ比較", async () => {
  const jws =
    "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInBheWVyIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzOGI5MWJEYmIwRTIyMzczZTM2YjY2IiwiaXNzdWVkQXQiOjE3MDMxMjM0NTYsInRyYW5zYWN0aW9uIjoiIn0.sig";
  const raw = { info: { receipt: { format: "jws", signature: jws } } };
  const jwsPayer = "0x857b06519E91e3A54538b91bDbb0E22373e36b66";
  const check = await checkOfferReceipt(raw, {
    resourceUrls: [RESOURCE],
    payer: jwsPayer,
    network: "eip155:8453",
  });
  assert.equal(check.receipt, "present");
  if (check.receipt !== "present") return;
  assert.equal(check.signature, "unverified_jws");
  assert.equal(check.signer, null);
  assert.equal(check.resourceUrl, "match");
  assert.equal(check.payer, "match");
  assert.equal(check.network, "match");

  const broken = await checkOfferReceipt(
    { info: { receipt: { format: "jws", signature: "a.b" } } },
    { resourceUrls: [RESOURCE], payer: KNOWN_ADDR, network: "eip155:8453" },
  );
  assert.ok(broken.receipt === "present");
  assert.equal(broken.signature, "unverified_jws");
  assert.equal(broken.resourceUrl, "missing");
  assert.equal(broken.payer, "missing");
  assert.equal(broken.network, "missing");
});

test("壊れた signature・型・offers のみは unrecoverable / absent で落ちない", async () => {
  const good = {
    version: 1,
    network: "eip155:8453",
    resourceUrl: RESOURCE,
    payer: KNOWN_ADDR,
    issuedAt: 1703123456,
    transaction: "",
  };
  const sig = await signReceiptPayload(good);
  const shortSig = {
    info: { receipt: { format: "eip712", payload: good, signature: "0xab" } },
  };
  const c1 = await checkOfferReceipt(shortSig, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.ok(c1.receipt === "present");
  assert.equal(c1.signature, "unrecoverable");

  const badVer = {
    info: {
      receipt: { format: "eip712", payload: { ...good, version: "1" }, signature: sig },
    },
  };
  const c2 = await checkOfferReceipt(badVer, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.ok(c2.receipt === "present");
  assert.equal(c2.signature, "unrecoverable");

  const negAt = {
    info: {
      receipt: { format: "eip712", payload: { ...good, issuedAt: -1 }, signature: sig },
    },
  };
  const c3 = await checkOfferReceipt(negAt, {
    resourceUrls: [RESOURCE],
    payer: KNOWN_ADDR,
    network: "eip155:8453",
  });
  assert.ok(c3.receipt === "present");
  assert.equal(c3.signature, "unrecoverable");

  const offersOnly = await checkOfferReceipt(
    { info: { offers: [{ format: "eip712" }] } },
    { resourceUrls: [RESOURCE], payer: KNOWN_ADDR, network: "eip155:8453" },
  );
  assert.ok(offersOnly.receipt === "absent");
  assert.equal(offersOnly.signature, "not_checked");
});

async function signedReceipt(payload: { version: number; network: string; resourceUrl: string; payer: string; issuedAt: number; transaction: string }) {
  const account = privateKeyToAccount(KNOWN_PK);
  const signature = await account.signTypedData({
    domain: RECEIPT_EIP712_DOMAIN,
    types: RECEIPT_EIP712_TYPES,
    primaryType: "Receipt",
    message: { ...payload, version: BigInt(payload.version), issuedAt: BigInt(payload.issuedAt) },
  });
  return { info: { receipt: { format: "eip712", payload, signature } } };
}

test("v1 の network slug: 期待 base と payload eip155:8453 は match・eip155:84532 は mismatch", async () => {
  const p = { version: 1, network: "eip155:8453", resourceUrl: RESOURCE, payer: KNOWN_ADDR, issuedAt: 1703123456, transaction: "" };
  const ok = await checkOfferReceipt(await signedReceipt(p), { resourceUrls: [RESOURCE], payer: KNOWN_ADDR.toLowerCase(), network: "base" });
  assert.ok(ok.receipt === "present");
  assert.equal(ok.signature, "recovered");
  assert.equal(ok.network, "match");
  assert.equal(ok.payer, "match", "EVM の payer は大小文字を無視する（payerLabel は小文字）");
  const ng = await checkOfferReceipt(await signedReceipt({ ...p, network: "eip155:84532" }), { resourceUrls: [RESOURCE], payer: KNOWN_ADDR, network: "base" });
  assert.ok(ng.receipt === "present");
  assert.equal(ng.network, "mismatch");
  const upper = await checkOfferReceipt(await signedReceipt({ ...p, payer: "0X" + KNOWN_ADDR.slice(2) }), { resourceUrls: [RESOURCE], payer: KNOWN_ADDR.toLowerCase(), network: "eip155:8453" });
  assert.ok(upper.receipt === "present");
  assert.equal(upper.payer, "match", "0X の大文字の接頭辞も同じアドレスとして比べる");
});

test("判定の欄は固定語と signer だけ・署名者は送られた原文で復元・U+0000 は保存の無害化で消える", async () => {
  const { pgSafeJson, pgSafeJsonChanged } = await import("@/lib/observatory/l1-runner");
  const p = { version: 1, network: "eip155:8453", resourceUrl: RESOURCE + "?x=\u0000", payer: KNOWN_ADDR, issuedAt: 1703123456, transaction: "" };
  const ext = await signedReceipt(p);
  const headers = headerFromBody({ ...baseSettlement(), extensions: { "offer-receipt": ext } });
  const r = parseSettlementResponse(headers);
  assert.ok(r?.offerReceipt && "raw" in r.offerReceipt);
  // l1-runner は送られた原文で判定し、保存の無害化で原文が変わるなら storedAltered を付ける（その条件がここで真）。
  const check = await checkOfferReceipt(r.offerReceipt.raw, { resourceUrls: [RESOURCE], payer: KNOWN_ADDR, network: "eip155:8453" });
  assert.ok(check.receipt === "present");
  assert.equal(check.signature, "recovered");
  assert.equal(check.signer, KNOWN_ADDR, "仕様 §5.5: 送られた payload そのもので digest を作る");
  assert.equal(check.resourceUrl, "match_path");
  assert.equal(pgSafeJsonChanged({ offerReceipt: r.offerReceipt.raw }).changed, true);
  const stored = pgSafeJson({ offerReceipt: r.offerReceipt.raw });
  assert.equal(JSON.stringify(stored).includes("\\u0000"), false, "保存する原文に U+0000 が残らない");
  const storedCheck = await checkOfferReceipt(stored.offerReceipt, { resourceUrls: [RESOURCE], payer: KNOWN_ADDR, network: "eip155:8453" });
  assert.ok(storedCheck.receipt === "present");
  assert.notEqual(storedCheck.signer, KNOWN_ADDR, "保存した写しからは同じ署名者にならない（だから storedAltered を残す）");
  const allowed = new Set(["checkVersion", "receipt", "format", "signature", "signer", "resourceUrl", "payer", "network", "authorization", "storedAltered"]);
  for (const [k, v] of Object.entries(check)) {
    assert.ok(allowed.has(k), `判定の欄に知らない鍵 ${k}`);
    if (k !== "signer" && typeof v === "string") assert.ok(!v.includes(RESOURCE), "売り手の文字列を写さない");
  }
});

test("署名の形が壊れていても3つの比較は payload の文字列で返す", async () => {
  const p = { version: 1, network: "eip155:8453", resourceUrl: RESOURCE, payer: KNOWN_ADDR, issuedAt: 1703123456, transaction: "" };
  const c = await checkOfferReceipt(
    { info: { receipt: { format: "eip712", payload: p, signature: "0x1234" } } },
    { resourceUrls: [RESOURCE], payer: KNOWN_ADDR, network: "eip155:8453" },
  );
  assert.ok(c.receipt === "present");
  assert.equal(c.signature, "unrecoverable");
  assert.equal(c.signer, null);
  assert.equal(c.resourceUrl, "match");
  assert.equal(c.payer, "match");
  assert.equal(c.network, "match");
});
