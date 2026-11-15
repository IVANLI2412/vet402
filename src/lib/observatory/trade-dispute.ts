// ============================================================
// P2: 争いの窓口の主張と鎖の事実と API 用ヘルパ（E6）。
// ============================================================
import { createHash } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
/** packages/sdk/src/auth-capture.ts と同じ。 */
const AUTH_CAPTURE_ESCROW_V1_1 = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
export const P2_DISPUTE_PAGE_PATH = "/connect/trade-dispute";

export const TRADE_ID_RE = /^0x[0-9a-f]{64}$/;

export function legCommitment(signedMessage: string, signature: string): string {
  return createHash("sha256")
    .update(signedMessage, "utf8")
    .update("\n")
    .update(signature.toLowerCase(), "utf8")
    .digest("hex");
}

const PAYMENT_INFO_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)",
  ),
);

export type AuthCapturePaymentInfoTuple = {
  operator: string;
  payer: string;
  receiver: string;
  token: string;
  maxAmount: bigint | string | number;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: string;
  salt: bigint | string | number;
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_U120 = 2n ** 120n;
const MAX_U48 = 2n ** 48n;
const MAX_U256 = 2n ** 256n;

function maxDecimalDigitsForMax(max: bigint): number {
  return (max - 1n).toString(10).length;
}

function parseBoundedInt(
  value: unknown,
  min: bigint,
  max: bigint,
): bigint | null {
  const digitCap = maxDecimalDigitsForMax(max);
  if (typeof value === "bigint") {
    if (value < min || value >= max) return null;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    const v = BigInt(value);
    if (v < min || v >= max) return null;
    return v;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    if (value.length > digitCap) return null;
    try {
      const v = BigInt(value);
      if (v < min || v >= max) return null;
      return v;
    } catch {
      return null;
    }
  }
  return null;
}

/** Submit 前の PaymentInfo 検査。不正なら null。 */
export function parseAuthCapturePaymentInfo(
  raw: unknown,
): AuthCapturePaymentInfoTuple | null {
  if (!raw || typeof raw !== "object") return null;
  const pi = raw as Record<string, unknown>;
  const operator = typeof pi.operator === "string" ? pi.operator : "";
  const payer = typeof pi.payer === "string" ? pi.payer : "";
  const receiver = typeof pi.receiver === "string" ? pi.receiver : "";
  const token = typeof pi.token === "string" ? pi.token : "";
  const feeReceiver = typeof pi.feeReceiver === "string" ? pi.feeReceiver : "";
  if (
    !ADDR_RE.test(operator) ||
    !ADDR_RE.test(payer) ||
    !ADDR_RE.test(receiver) ||
    !ADDR_RE.test(token) ||
    !ADDR_RE.test(feeReceiver)
  ) {
    return null;
  }
  const maxAmount = parseBoundedInt(pi.maxAmount, 0n, MAX_U120);
  const preApprovalExpiry = parseBoundedInt(pi.preApprovalExpiry, 0n, MAX_U48);
  const authorizationExpiry = parseBoundedInt(pi.authorizationExpiry, 0n, MAX_U48);
  const refundExpiry = parseBoundedInt(pi.refundExpiry, 0n, MAX_U48);
  const salt = parseBoundedInt(pi.salt, 0n, MAX_U256);
  if (
    maxAmount === null ||
    preApprovalExpiry === null ||
    authorizationExpiry === null ||
    refundExpiry === null ||
    salt === null
  ) {
    return null;
  }
  if (typeof pi.minFeeBps !== "number" || !Number.isInteger(pi.minFeeBps) || pi.minFeeBps < 0 || pi.minFeeBps > 65535) {
    return null;
  }
  if (typeof pi.maxFeeBps !== "number" || !Number.isInteger(pi.maxFeeBps) || pi.maxFeeBps < 0 || pi.maxFeeBps > 65535) {
    return null;
  }
  return {
    operator: operator.toLowerCase(),
    payer: payer.toLowerCase(),
    receiver: receiver.toLowerCase(),
    token: token.toLowerCase(),
    maxAmount,
    preApprovalExpiry: Number(preApprovalExpiry),
    authorizationExpiry: Number(authorizationExpiry),
    refundExpiry: Number(refundExpiry),
    minFeeBps: pi.minFeeBps,
    maxFeeBps: pi.maxFeeBps,
    feeReceiver: feeReceiver.toLowerCase(),
    salt,
  };
}

export function hashPaymentInfo(
  chainId: number,
  info: AuthCapturePaymentInfoTuple,
  payer: string,
  escrow: string = AUTH_CAPTURE_ESCROW_V1_1,
): string {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint120" },
        { type: "uint48" },
        { type: "uint48" },
        { type: "uint48" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        PAYMENT_INFO_TYPEHASH,
        info.operator as Hex,
        payer as Hex,
        info.receiver as Hex,
        info.token as Hex,
        BigInt(info.maxAmount),
        info.preApprovalExpiry,
        info.authorizationExpiry,
        info.refundExpiry,
        info.minFeeBps,
        info.maxFeeBps,
        info.feeReceiver as Hex,
        BigInt(info.salt),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(chainId), escrow as Hex, inner],
    ),
  ).toLowerCase();
}

export type PartyLegView = {
  tradeId: string;
  side: "payer" | "seller";
  commitment: string;
  receivedBodySha256?: string;
  deliveredBodySha256?: string;
  paymentTx?: string;
};

export type PublicClaimJson = {
  signer: string;
  paymentTx: string;
  delivery: "none" | "received" | "delivered";
  receivedBodySha256?: string | null;
  deliveredBodySha256?: string | null;
  paymentSeen?: "yes" | "no";
  sellerReceipt: { verified: boolean } | null;
  issued: string;
  acceptedAt: string;
  commitment: string;
};

export type PublicClaimsSideJson = {
  current: PublicClaimJson | null;
  history: PublicClaimJson[];
};

export type ChainFactsPaymentInfoJson = {
  operator: string;
  payer: string;
  receiver: string;
  token: string;
  maxAmount: string;
};

export type ChainFactsPaymentStateJson = {
  hasCollectedPayment: boolean;
  capturableAmount: string;
  refundableAmount: string;
};

export type ChainFactsNamedTxJson = {
  hash: string;
  match: "matched" | "unmatched" | "unavailable";
};

export type ChainFactsJson = {
  status: "matched" | "unmatched" | "unavailable";
  readAtBlock: string | null;
  authorizeTx: {
    hash: string;
    blockNumber: number;
    blockTimestamp: number;
    status: "success" | "reverted";
  } | null;
  paymentInfo: ChainFactsPaymentInfoJson | null;
  amount: string | null;
  paymentState: ChainFactsPaymentStateJson | null;
  namedTxs: ChainFactsNamedTxJson[];
};

export const P2_CLAIMS_NOTE =
  "vet402 shows what each side signed and what the chain shows at readAtBlock. vet402 does not assign blame.";

export type PublicClaimsJson = {
  tradeId: string;
  chain: string;
  draft: true;
  recordKind: "claims_and_chain_facts";
  claims: {
    payer: PublicClaimsSideJson;
    seller: PublicClaimsSideJson;
  };
  chainFacts: ChainFactsJson;
  anchor: {
    payer: { day: string; commitment: string } | null;
    seller: { day: string; commitment: string } | null;
  };
  note: string;
};

export function buildPublicClaimsJson(input: {
  tradeId: string;
  chain: string;
  claims: {
    payer: PublicClaimsSideJson;
    seller: PublicClaimsSideJson;
  };
  chainFacts: ChainFactsJson;
  anchor: PublicClaimsJson["anchor"];
}): PublicClaimsJson {
  return {
    tradeId: input.tradeId.toLowerCase(),
    chain: input.chain,
    draft: true,
    recordKind: "claims_and_chain_facts",
    claims: input.claims,
    chainFacts: input.chainFacts,
    anchor: input.anchor,
    note: P2_CLAIMS_NOTE,
  };
}