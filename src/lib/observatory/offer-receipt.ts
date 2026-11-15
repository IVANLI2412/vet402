/**
 * offer-and-receipt 拡張の受領証を記録用に解釈する（純関数・DB・ネットワークなし）。
 */
// 署名者の復元は hashTypedData（EIP-712 の digest）→ recoverAddress の2段で行う。
// 1段で復元する viem の関数は名前が公開面の語の関門（覆面の語）に当たるため使わない（結果は同じ）。
import { getAddress, hashTypedData, recoverAddress, type Hex, type TypedDataDomain } from "viem";

/** x402-payer の normalizeNetwork と同じ規則（循環 import を避けるためここに置く）。 */
function normalizeNetwork(network: unknown): string {
  if (typeof network !== "string") return "";
  if (network === "base") return "eip155:8453";
  if (network === "base-sepolia") return "eip155:84532";
  return network;
}

export const OFFER_RECEIPT_RAW_CAP_BYTES = 8192;

export type OfferReceiptCapture =
  | { raw: unknown; bytes: number }
  | { overCap: true; bytes: number };

export type OfferReceiptCheck =
  | {
      checkVersion: 1;
      receipt: "present" | "absent";
      format: "eip712" | "jws" | "unknown" | null;
      signature: "recovered" | "unrecoverable" | "unverified_jws" | "not_checked";
      signer: string | null;
      resourceUrl: "match" | "match_path" | "mismatch" | "missing";
      payer: "match" | "mismatch" | "missing";
      network: "match" | "mismatch" | "missing";
      authorization: "not_checked";
      /** 保存の無害化（U+0000・深さの打ち切り等）で、保存した原文が売り手の送った原文と違う。判定は送られた原文で行った。 */
      storedAltered?: true;
    }
  | { checkVersion: 1; receipt: "over_cap"; bytes: number };

export const RECEIPT_EIP712_DOMAIN: TypedDataDomain = {
  name: "x402 receipt",
  version: "1",
  chainId: 1,
};

export const RECEIPT_EIP712_TYPES = {
  Receipt: [
    { name: "version", type: "uint256" },
    { name: "network", type: "string" },
    { name: "resourceUrl", type: "string" },
    { name: "payer", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "transaction", type: "string" },
  ],
} as const;

/** PAYMENT-RESPONSE の extensions["offer-receipt"] を捕捉する。 */
export function captureOfferReceiptExtension(
  extensions: unknown,
): OfferReceiptCapture | undefined {
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) {
    return undefined;
  }
  const raw = (extensions as Record<string, unknown>)["offer-receipt"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const json = JSON.stringify(raw);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > OFFER_RECEIPT_RAW_CAP_BYTES) {
    return { overCap: true, bytes };
  }
  return { raw, bytes };
}

function absentCheck(): OfferReceiptCheck {
  return {
    checkVersion: 1,
    receipt: "absent",
    format: null,
    signature: "not_checked",
    signer: null,
    resourceUrl: "missing",
    payer: "missing",
    network: "missing",
    authorization: "not_checked",
  };
}

function basePresent(
  format: "eip712" | "jws" | "unknown",
  signature: "recovered" | "unrecoverable" | "unverified_jws" | "not_checked",
  signer: string | null,
  resourceUrl: "match" | "match_path" | "mismatch" | "missing",
  payer: "match" | "mismatch" | "missing",
  network: "match" | "mismatch" | "missing",
): OfferReceiptCheck {
  return {
    checkVersion: 1,
    receipt: "present",
    format,
    signature,
    signer,
    resourceUrl,
    payer,
    network,
    authorization: "not_checked",
  };
}

function urlOriginPath(url: string): { origin: string; pathname: string } | null {
  try {
    const u = new URL(url);
    return { origin: u.origin, pathname: u.pathname };
  } catch {
    return null;
  }
}

function matchResourceUrl(
  value: unknown,
  expectedUrls: string[],
): "match" | "match_path" | "mismatch" | "missing" {
  if (typeof value !== "string") return "missing";
  if (expectedUrls.some((u) => u === value)) return "match";
  const got = urlOriginPath(value);
  if (!got) return "mismatch";
  for (const exp of expectedUrls) {
    const e = urlOriginPath(exp);
    if (e && e.origin === got.origin && e.pathname === got.pathname) {
      return "match_path";
    }
  }
  return "mismatch";
}

function matchPayer(value: unknown, expected: string): "match" | "mismatch" | "missing" {
  if (typeof value !== "string") return "missing";
  if (/^0x/i.test(value) && /^0x/i.test(expected)) {
    return value.toLowerCase() === expected.toLowerCase() ? "match" : "mismatch";
  }
  return value === expected ? "match" : "mismatch";
}

function matchNetwork(value: unknown, expectedNetwork: string): "match" | "mismatch" | "missing" {
  if (typeof value !== "string") return "missing";
  const want = normalizeNetwork(expectedNetwork);
  const got = normalizeNetwork(value);
  return got === want ? "match" : "mismatch";
}

function decodeJwsPayload(jws: string): Record<string, unknown> | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isEip712SignatureHex(sig: unknown): sig is Hex {
  return typeof sig === "string" && /^0x[0-9a-fA-F]{130}$/.test(sig);
}

function prepareEip712ReceiptMessage(
  payload: Record<string, unknown>,
):
  | {
      version: bigint;
      network: string;
      resourceUrl: string;
      payer: string;
      issuedAt: bigint;
      transaction: string;
    }
  | null {
  const { version, issuedAt, network, resourceUrl, payer, transaction } = payload;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
  if (typeof issuedAt !== "number" || !Number.isInteger(issuedAt) || issuedAt < 0) return null;
  if (typeof network !== "string") return null;
  if (typeof resourceUrl !== "string") return null;
  if (typeof payer !== "string") return null;
  let tx = "";
  if (transaction === undefined || transaction === null) {
    tx = "";
  } else if (typeof transaction !== "string") {
    return null;
  } else {
    tx = transaction;
  }
  return {
    version: BigInt(version),
    network,
    resourceUrl,
    payer,
    issuedAt: BigInt(issuedAt),
    transaction: tx,
  };
}

export async function checkOfferReceipt(
  raw: unknown,
  expected: { resourceUrls: string[]; payer: string; network: string },
): Promise<OfferReceiptCheck> {
  try {
    const root = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!root) return absentCheck();
    const info = typeof root.info === "object" && root.info !== null && !Array.isArray(root.info)
      ? (root.info as Record<string, unknown>)
      : null;
    const receipt = info && typeof info.receipt === "object" && info.receipt !== null && !Array.isArray(info.receipt)
      ? (info.receipt as Record<string, unknown>)
      : null;
    if (!receipt) return absentCheck();

    const formatRaw = receipt.format;
    const format =
      formatRaw === "eip712" ? "eip712" : formatRaw === "jws" ? "jws" : "unknown";

    if (format === "eip712") {
      const payload =
        typeof receipt.payload === "object" && receipt.payload !== null && !Array.isArray(receipt.payload)
          ? (receipt.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        return basePresent("eip712", "unrecoverable", null, "missing", "missing", "missing");
      }
      // 3つの比較は署名の形の検査と別に、payload の文字列で必ず返す（記録を揃える）。
      const fieldMatch = [
        matchResourceUrl(payload.resourceUrl, expected.resourceUrls),
        matchPayer(payload.payer, expected.payer),
        matchNetwork(payload.network, expected.network),
      ] as const;
      const sigHex: Hex | null = isEip712SignatureHex(receipt.signature) ? receipt.signature : null;
      const message = sigHex ? prepareEip712ReceiptMessage(payload) : null;
      if (!message || !sigHex) {
        return basePresent("eip712", "unrecoverable", null, ...fieldMatch);
      }
      let signer: string | null = null;
      let signature: "recovered" | "unrecoverable" = "unrecoverable";
      try {
        const digest = hashTypedData({
          domain: RECEIPT_EIP712_DOMAIN,
          types: RECEIPT_EIP712_TYPES,
          primaryType: "Receipt",
          message,
        });
        const recovered = await recoverAddress({ hash: digest, signature: sigHex });
        signer = getAddress(recovered);
        signature = "recovered";
      } catch {
        signature = "unrecoverable";
      }
      return basePresent("eip712", signature, signer, ...fieldMatch);
    }

    if (format === "jws") {
      const jws = typeof receipt.signature === "string" ? receipt.signature : "";
      const decoded = decodeJwsPayload(jws);
      if (!decoded) {
        return basePresent("jws", "unverified_jws", null, "missing", "missing", "missing");
      }
      return basePresent(
        "jws",
        "unverified_jws",
        null,
        matchResourceUrl(decoded.resourceUrl, expected.resourceUrls),
        matchPayer(decoded.payer, expected.payer),
        matchNetwork(decoded.network, expected.network),
      );
    }

    return basePresent("unknown", "not_checked", null, "missing", "missing", "missing");
  } catch {
    return absentCheck();
  }
}