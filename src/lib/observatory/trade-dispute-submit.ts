// ============================================================
// P2 争いの端の受理（署名・チェーン検証・保存）。
// ============================================================
import { verifyMessage, type Hex } from "viem";
import { isValidIssuedAt } from "@/lib/verify-message";
import {
  parseBodySha256Field,
  tradeDisputeDeliveryReceiptMessage,
  tradeDisputeLegSignMessage,
  TRADE_DISPUTE_CHAIN,
  type PayerClaimDelivery,
  type SellerClaimDelivery,
  type SellerPaymentSeen,
} from "@/lib/observatory/e6-leg-sign";
import {
  decodeAuthorizePaymentInfo,
  getE6ChainReader,
  type E6TestChainReader,
} from "@/lib/observatory/e6-chain-reader";
import {
  signingWalletForLeg,
  utcDayOfIso,
  writeLimitPerTradeSide,
  writeLimitPerWallet,
} from "@/lib/observatory/trade-dispute-write-limits";
import { hashPaymentInfo, legCommitment } from "@/lib/observatory/trade-dispute";
import {
  getTradeDisputeStore,
  type TradeDisputeLegRow,
  type TradeDisputeStore,
} from "@/lib/observatory/trade-dispute-store";

const SIG_RE = /^0x[a-fA-F0-9]{130}$/;
const TX_RE = /^0x[a-fA-F0-9]{64}$/;
const TRADE_ID_RE = /^0x[a-fA-F0-9]{64}$/;
const ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
const CHAIN_ID = 84532;
const ISSUED_WINDOW_MS = 10 * 60_000;
const RECEIPT_ISSUED_FUTURE_MS = 5 * 60_000;

export type SubmitResult =
  | { ok: true; commitment: string }
  | { ok: false; reason: string; status: number };

async function resolvePaymentParties(
  paymentTx: string,
  tradeId: string,
): Promise<
  | {
      ok: true;
      payer: string;
      receiver: string;
      paymentInfoOperator: string;
    }
  | { ok: false; reason: string; status: number }
> {
  const reader = getE6ChainReader(TRADE_DISPUTE_CHAIN);
  if (reader === "unavailable") return { ok: false, reason: "chain_unavailable", status: 503 };

  const call = await reader.getEscrowCall(paymentTx, ESCROW);
  if (call === "unavailable") return { ok: false, reason: "chain_unavailable", status: 503 };
  if (call === "not_found") return { ok: false, reason: "payment_tx_not_found", status: 422 };
  if (call === "rejected") return { ok: false, reason: "not_a_party", status: 422 };

  const paymentInfo = decodeAuthorizePaymentInfo(call.input);
  if (!paymentInfo) return { ok: false, reason: "not_a_party", status: 422 };

  const pi = paymentInfo as Record<string, unknown>;
  const payerWallet = typeof pi.payer === "string" ? pi.payer.toLowerCase() : "";
  const receiver = typeof pi.receiver === "string" ? pi.receiver.toLowerCase() : "";
  const operatorFromInfo = typeof pi.operator === "string" ? pi.operator.toLowerCase() : "";
  if (!payerWallet || !receiver || !operatorFromInfo) {
    return { ok: false, reason: "not_a_party", status: 422 };
  }

  let computed: string;
  try {
    computed = hashPaymentInfo(CHAIN_ID, paymentInfo as never, payerWallet, ESCROW);
  } catch {
    return { ok: false, reason: "not_a_party", status: 422 };
  }
  if (computed !== tradeId) return { ok: false, reason: "not_a_party", status: 422 };

  return { ok: true, payer: payerWallet, receiver, paymentInfoOperator: operatorFromInfo };
}

async function writeLimitResult(
  store: TradeDisputeStore,
  row: Pick<TradeDisputeLegRow, "tradeId" | "side" | "signer" | "acceptedAt">,
): Promise<SubmitResult | null> {
  const wallet = signingWalletForLeg(row as TradeDisputeLegRow);
  const day = utcDayOfIso(row.acceptedAt);
  const walletCount = await store.countWrites(wallet, day);
  if (walletCount >= writeLimitPerWallet) {
    return { ok: false, reason: "write_limit_reached", status: 429 };
  }
  const sideCount = await store.countLegsForSide(row.tradeId, row.side);
  if (sideCount >= writeLimitPerTradeSide) {
    return { ok: false, reason: "write_limit_reached", status: 429 };
  }
  return null;
}

function issuedStale(currentIssued: string | undefined, newIssued: string): boolean {
  if (!currentIssued) return false;
  return Date.parse(newIssued) <= Date.parse(currentIssued);
}

export async function submitTradeDisputeLeg(
  body: Record<string, unknown>,
  store: TradeDisputeStore | null = getTradeDisputeStore(),
): Promise<SubmitResult> {
  if (!store) return { ok: false, reason: "disputes_unavailable", status: 503 };
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "submit") return { ok: false, reason: "invalid_request", status: 400 };

  const side = body.side === "payer" || body.side === "seller" ? body.side : null;
  if (!side) return { ok: false, reason: "invalid_request", status: 400 };

  const tradeId = typeof body.tradeId === "string" ? body.tradeId.trim().toLowerCase() : "";
  if (!TRADE_ID_RE.test(tradeId)) return { ok: false, reason: "invalid_request", status: 400 };

  const chain = typeof body.chain === "string" ? body.chain : "";
  if (chain !== TRADE_DISPUTE_CHAIN) {
    return { ok: false, reason: chain ? "unsupported_chain" : "invalid_request", status: chain ? 400 : 400 };
  }

  const signature = typeof body.signature === "string" ? body.signature : "";
  const issued = typeof body.issued === "string" ? body.issued : "";
  if (!SIG_RE.test(signature) || !isValidIssuedAt(issued)) {
    return { ok: false, reason: "invalid_signature", status: 400 };
  }
  if (Math.abs(Date.now() - Date.parse(issued)) > ISSUED_WINDOW_MS) {
    return { ok: false, reason: "signature_expired", status: 400 };
  }

  const paymentTx = typeof body.paymentTx === "string" ? body.paymentTx.trim().toLowerCase() : "";
  if (!TX_RE.test(paymentTx)) return { ok: false, reason: "invalid_request", status: 400 };

  const parties = await resolvePaymentParties(paymentTx, tradeId);
  if (!parties.ok) return parties;

  const { payer: payerWallet, receiver, paymentInfoOperator } = parties;
  const signerWallet = side === "payer" ? payerWallet : receiver;

  const existing = await store.getLegs(tradeId);
  const current = side === "payer" ? existing.payer.current : existing.seller.current;
  const priorForSide =
    side === "payer"
      ? [...existing.payer.history, ...(existing.payer.current ? [existing.payer.current] : [])]
      : [...existing.seller.history, ...(existing.seller.current ? [existing.seller.current] : [])];
  if (priorForSide.some((r) => r.issued === issued)) {
    return { ok: false, reason: "already_recorded", status: 409 };
  }
  if (issuedStale(current?.issued, issued)) {
    return { ok: false, reason: "stale_claim", status: 409 };
  }

  if (side === "payer") {
    const delivery = body.delivery;
    if (delivery !== "none" && delivery !== "received") {
      return { ok: false, reason: "invalid_request", status: 400 };
    }
    const hashField = typeof body.receivedBodySha256 === "string" ? body.receivedBodySha256 : "";
    const receivedBodySha256 = parseBodySha256Field(hashField);
    if (delivery === "received" && receivedBodySha256 === null) {
      return { ok: false, reason: "invalid_request", status: 400 };
    }
    if (delivery === "none" && hashField.trim().toLowerCase() !== "none") {
      return { ok: false, reason: "invalid_request", status: 400 };
    }

    const message = tradeDisputeLegSignMessage({
      tradeId,
      side: "payer",
      paymentTx,
      delivery: delivery as PayerClaimDelivery,
      receivedBodySha256: delivery === "received" ? receivedBodySha256 : null,
      issued,
    });

    let verified: boolean;
    try {
      verified = await verifyMessage({
        address: signerWallet as Hex,
        message,
        signature: signature as Hex,
      });
    } catch {
      return { ok: false, reason: "invalid_signature", status: 400 };
    }
    if (!verified) return { ok: false, reason: "invalid_signature", status: 400 };

    const acceptedAt = new Date().toISOString();
    const limitProbe: TradeDisputeLegRow = {
      tradeId,
      side: "payer",
      chain,
      payer: payerWallet,
      receiver,
      paymentInfoOperator,
      signer: signerWallet,
      paymentTx,
      delivery: delivery as string,
      receivedBodySha256: delivery === "received" ? receivedBodySha256 : null,
      paymentSeen: null,
      deliveredBodySha256: null,
      sellerReceiptCommitment: null,
      sellerReceiptSignature: null,
      sellerReceiptIssued: null,
      commitment: "",
      issued,
      acceptedAt,
    };
    const limit = await writeLimitResult(store, limitProbe);
    if (limit) return limit;

    let sellerReceiptCommitment: string | null = null;
    let sellerReceiptSignature: string | null = null;
    let sellerReceiptIssued: string | null = null;
    const receiptRaw = body.sellerReceipt as Record<string, unknown> | undefined;
    if (receiptRaw) {
      const rSig = typeof receiptRaw.signature === "string" ? receiptRaw.signature : "";
      const rIssued = typeof receiptRaw.issued === "string" ? receiptRaw.issued : "";
      if (!SIG_RE.test(rSig) || !isValidIssuedAt(rIssued)) {
        return { ok: false, reason: "invalid_seller_receipt", status: 400 };
      }
      if (Date.parse(rIssued) > Date.now() + RECEIPT_ISSUED_FUTURE_MS) {
        return { ok: false, reason: "invalid_seller_receipt", status: 400 };
      }
      if (!receivedBodySha256) {
        return { ok: false, reason: "invalid_seller_receipt", status: 400 };
      }
      const rMsg = tradeDisputeDeliveryReceiptMessage({
        tradeId,
        bodySha256: receivedBodySha256,
        issued: rIssued,
      });
      let rOk: boolean;
      try {
        rOk = await verifyMessage({
          address: receiver as Hex,
          message: rMsg,
          signature: rSig as Hex,
        });
      } catch {
        return { ok: false, reason: "invalid_seller_receipt", status: 400 };
      }
      if (!rOk) return { ok: false, reason: "invalid_seller_receipt", status: 400 };
      sellerReceiptCommitment = legCommitment(rMsg, rSig);
      sellerReceiptSignature = rSig.toLowerCase();
      sellerReceiptIssued = rIssued;
    }

    const commitment = legCommitment(message, signature);
    const row: TradeDisputeLegRow = {
      ...limitProbe,
      sellerReceiptCommitment,
      sellerReceiptSignature,
      sellerReceiptIssued,
      commitment,
    };
    try {
      await store.insertLeg(row);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "already_recorded") return { ok: false, reason: "already_recorded", status: 409 };
      if (code === "stale_claim") return { ok: false, reason: "stale_claim", status: 409 };
      if (code === "write_limit_reached") return { ok: false, reason: "write_limit_reached", status: 429 };
      if (code === "disputes_unavailable") return { ok: false, reason: "disputes_unavailable", status: 503 };
      throw e;
    }
    return { ok: true, commitment };
  }

  const paymentSeen = body.paymentSeen;
  if (paymentSeen !== "yes" && paymentSeen !== "no") return { ok: false, reason: "invalid_request", status: 400 };
  const delivery = body.delivery;
  if (delivery !== "none" && delivery !== "delivered") {
    return { ok: false, reason: "invalid_request", status: 400 };
  }
  const dHashField = typeof body.deliveredBodySha256 === "string" ? body.deliveredBodySha256 : "";
  const deliveredBodySha256 = parseBodySha256Field(dHashField);
  if (delivery === "delivered" && deliveredBodySha256 === null) {
    return { ok: false, reason: "invalid_request", status: 400 };
  }
  if (delivery === "none" && dHashField.trim().toLowerCase() !== "none") {
    return { ok: false, reason: "invalid_request", status: 400 };
  }

  const message = tradeDisputeLegSignMessage({
    tradeId,
    side: "seller",
    paymentTx,
    paymentSeen: paymentSeen as SellerPaymentSeen,
    delivery: delivery as SellerClaimDelivery,
    deliveredBodySha256: delivery === "delivered" ? deliveredBodySha256 : null,
    issued,
  });

  let verifiedSeller: boolean;
  try {
    verifiedSeller = await verifyMessage({
      address: signerWallet as Hex,
      message,
      signature: signature as Hex,
    });
  } catch {
    return { ok: false, reason: "invalid_signature", status: 400 };
  }
  if (!verifiedSeller) return { ok: false, reason: "invalid_signature", status: 400 };

  const acceptedAt = new Date().toISOString();
  const limitProbe: TradeDisputeLegRow = {
    tradeId,
    side: "seller",
    chain,
    payer: payerWallet,
    receiver,
    paymentInfoOperator,
    signer: signerWallet,
    paymentTx,
    delivery: delivery as string,
    receivedBodySha256: null,
    paymentSeen,
    deliveredBodySha256: delivery === "delivered" ? deliveredBodySha256 : null,
    sellerReceiptCommitment: null,
    sellerReceiptSignature: null,
    sellerReceiptIssued: null,
    commitment: "",
    issued,
    acceptedAt,
  };
  const limit = await writeLimitResult(store, limitProbe);
  if (limit) return limit;

  const commitment = legCommitment(message, signature);
  const row: TradeDisputeLegRow = { ...limitProbe, commitment };
  try {
    await store.insertLeg(row);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "already_recorded") return { ok: false, reason: "already_recorded", status: 409 };
    if (code === "stale_claim") return { ok: false, reason: "stale_claim", status: 409 };
    if (code === "write_limit_reached") return { ok: false, reason: "write_limit_reached", status: 429 };
    if (code === "disputes_unavailable") return { ok: false, reason: "disputes_unavailable", status: 503 };
    throw e;
  }
  return { ok: true, commitment };
}

export type { E6TestChainReader };