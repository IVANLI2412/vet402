// ============================================================
// P2 争いの窓口: 鎖の事実の読み取りと公開 JSON の組み立て。
// ============================================================
import { verifyMessage, type Hex } from "viem";
import {
  decodeAuthorizeAmount,
  decodeAuthorizePaymentInfo,
  getE6ChainReader,
  type E6ChainReader,
} from "@/lib/observatory/e6-chain-reader";
import { tradeDisputeDeliveryReceiptMessage } from "@/lib/observatory/e6-leg-sign";
import {
  buildPublicClaimsJson,
  hashPaymentInfo,
  type ChainFactsJson,
  type PublicClaimJson,
  type PublicClaimsJson,
  type ChainFactsNamedTxJson,
  type PublicClaimsSideJson,
} from "@/lib/observatory/trade-dispute";
import type { TradeDisputeDayAnchors, TradeDisputeLegRow } from "@/lib/observatory/trade-dispute-store";

const AUTH_CAPTURE_ESCROW_V1_1 = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
const PUBLIC_READ_CHAIN = "eip155:84532";
const CHAIN_ID = 84532;

export async function verifySellerReceiptOnPublic(
  tradeId: string,
  bodySha256: string,
  receiver: string,
  signature: string,
  issued: string,
): Promise<boolean> {
  if (!bodySha256 || !signature || !issued) return false;
  const message = tradeDisputeDeliveryReceiptMessage({
    tradeId: tradeId.toLowerCase(),
    bodySha256,
    issued,
  });
  try {
    return await verifyMessage({
      address: receiver as Hex,
      message,
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

function paymentInfoToPublic(pi: Record<string, unknown>): ChainFactsJson["paymentInfo"] {
  const maxAmount = pi.maxAmount;
  let maxAmountStr: string;
  if (typeof maxAmount === "bigint") maxAmountStr = maxAmount.toString();
  else if (typeof maxAmount === "string" || typeof maxAmount === "number") maxAmountStr = String(maxAmount);
  else return null;
  const operator = typeof pi.operator === "string" ? pi.operator.toLowerCase() : "";
  const payer = typeof pi.payer === "string" ? pi.payer.toLowerCase() : "";
  const receiver = typeof pi.receiver === "string" ? pi.receiver.toLowerCase() : "";
  const token = typeof pi.token === "string" ? pi.token.toLowerCase() : "";
  if (!operator || !payer || !receiver || !token) return null;
  return { operator, payer, receiver, token, maxAmount: maxAmountStr };
}

function unmatchedChainFacts(readAtBlock: string, namedTxs: ChainFactsNamedTxJson[] = []): ChainFactsJson {
  return {
    status: "unmatched",
    readAtBlock,
    authorizeTx: null,
    paymentInfo: null,
    amount: null,
    paymentState: null,
    namedTxs,
  };
}

function unavailableChainFacts(namedTxs: ChainFactsNamedTxJson[] = []): ChainFactsJson {
  return {
    status: "unavailable",
    readAtBlock: null,
    authorizeTx: null,
    paymentInfo: null,
    amount: null,
    paymentState: null,
    namedTxs,
  };
}

async function readOnePaymentTxAtBlock(
  reader: E6ChainReader,
  tradeId: string,
  paymentTx: string,
  blockNumber: number,
): Promise<"unmatched" | "unavailable" | ChainFactsJson> {
  const read = await reader.readAuthorizeAtBlock(paymentTx, AUTH_CAPTURE_ESCROW_V1_1, blockNumber);
  if (read === "unavailable") return "unavailable";
  if (read === "not_found" || read === "rejected") return "unmatched";

  const decoded =
    read.paymentInfo ?? decodeAuthorizePaymentInfo(read.input);
  if (!decoded) return "unmatched";

  const pi = decoded as Record<string, unknown>;
  const payer = typeof pi.payer === "string" ? pi.payer.toLowerCase() : "";
  let computed: string;
  try {
    computed = hashPaymentInfo(CHAIN_ID, decoded as never, payer, AUTH_CAPTURE_ESCROW_V1_1);
  } catch {
    return "unmatched";
  }
  if (computed !== tradeId.toLowerCase()) return "unmatched";

  const paymentInfo = paymentInfoToPublic(pi);
  if (!paymentInfo) return "unmatched";
  const amount = decodeAuthorizeAmount(read.input);

  const state = await reader.readPaymentStateAtBlock(AUTH_CAPTURE_ESCROW_V1_1, tradeId, blockNumber);
  if (state === "unavailable") return "unavailable";

  return {
    status: "matched",
    readAtBlock: String(blockNumber),
    authorizeTx: {
      hash: read.hash,
      blockNumber: read.blockNumber,
      blockTimestamp: read.blockTimestamp,
      status: read.status,
    },
    paymentInfo,
    amount,
    paymentState: {
      hasCollectedPayment: state.collected,
      capturableAmount: state.capturable,
      refundableAmount: state.refundable,
    },
    namedTxs: [],
  };
}

export async function buildChainFacts(
  reader: E6ChainReader | "unavailable",
  tradeId: string,
  payerTx: string | null,
  sellerTx: string | null,
): Promise<ChainFactsJson> {
  if (reader === "unavailable") return unavailableChainFacts();

  const blockNumber = await reader.getLatestBlockNumber();
  if (blockNumber === "unavailable") return unavailableChainFacts();
  const readAtBlock = String(blockNumber);

  const txs = new Set<string>();
  if (payerTx) txs.add(payerTx.toLowerCase());
  if (sellerTx) txs.add(sellerTx.toLowerCase());
  if (txs.size === 0) return unmatchedChainFacts(readAtBlock);

  const txList = [...txs];
  const namedTxs: ChainFactsNamedTxJson[] = [];
  let matchedFacts: ChainFactsJson | null = null;
  let sawUnavailable = false;

  for (const tx of txList) {
    const result = await readOnePaymentTxAtBlock(reader, tradeId, tx, blockNumber);
    if (result === "unavailable") {
      sawUnavailable = true;
      namedTxs.push({ hash: tx, match: "unavailable" });
      continue;
    }
    if (result === "unmatched") {
      namedTxs.push({ hash: tx, match: "unmatched" });
      continue;
    }
    if (typeof result === "object") {
      namedTxs.push({ hash: tx, match: "matched" });
      if (!matchedFacts) matchedFacts = result;
    }
  }

  if (matchedFacts) return { ...matchedFacts, namedTxs };
  if (sawUnavailable) return unavailableChainFacts(namedTxs);
  return unmatchedChainFacts(readAtBlock, namedTxs);
}

export function rowToPublicClaim(
  row: TradeDisputeLegRow,
  sellerReceiptVerified: boolean,
): PublicClaimJson {
  const base: PublicClaimJson = {
    signer: row.signer,
    paymentTx: row.paymentTx,
    delivery: row.delivery as PublicClaimJson["delivery"],
    issued: row.issued,
    acceptedAt: row.acceptedAt,
    commitment: row.commitment,
    sellerReceipt: null,
  };
  if (row.side === "payer") {
    base.receivedBodySha256 = row.receivedBodySha256;
    if (row.sellerReceiptSignature && row.sellerReceiptIssued) {
      base.sellerReceipt = { verified: sellerReceiptVerified };
    }
  } else {
    base.paymentSeen = row.paymentSeen as "yes" | "no";
    base.deliveredBodySha256 = row.deliveredBodySha256;
  }
  return base;
}

function sideToPublicClaims(
  legs: { current: TradeDisputeLegRow | null; history: TradeDisputeLegRow[] },
  verifyReceipt: (row: TradeDisputeLegRow) => Promise<boolean>,
): Promise<PublicClaimsSideJson> {
  return (async () => {
    const current = legs.current
      ? rowToPublicClaim(legs.current, await verifyReceipt(legs.current))
      : null;
    const history: PublicClaimJson[] = [];
    for (const row of legs.history) {
      history.push(rowToPublicClaim(row, await verifyReceipt(row)));
    }
    return { current, history };
  })();
}

export async function buildPublicClaimsJsonWithChain(
  input: {
    tradeId: string;
    chain: string;
    legs: {
      payer: { current: TradeDisputeLegRow | null; history: TradeDisputeLegRow[] };
      seller: { current: TradeDisputeLegRow | null; history: TradeDisputeLegRow[] };
    };
    anchors?: TradeDisputeDayAnchors;
  },
  reader: E6ChainReader | "unavailable" = getE6ChainReader(PUBLIC_READ_CHAIN),
): Promise<PublicClaimsJson> {
  const receiver =
    input.legs.payer.current?.receiver ??
    input.legs.seller.current?.receiver ??
    input.legs.payer.history[0]?.receiver ??
    input.legs.seller.history[0]?.receiver ??
    "";

  const verifyPayerReceipt = async (row: TradeDisputeLegRow) => {
    if (row.side !== "payer" || !row.receivedBodySha256) return false;
    if (!row.sellerReceiptSignature || !row.sellerReceiptIssued) return false;
    return verifySellerReceiptOnPublic(
      input.tradeId,
      row.receivedBodySha256,
      receiver,
      row.sellerReceiptSignature,
      row.sellerReceiptIssued,
    );
  };

  const payerClaims = await sideToPublicClaims(input.legs.payer, verifyPayerReceipt);
  const sellerClaims = await sideToPublicClaims(input.legs.seller, async () => false);

  const payerTx = input.legs.payer.current?.paymentTx ?? null;
  const sellerTx = input.legs.seller.current?.paymentTx ?? null;
  const chainFacts = await buildChainFacts(reader, input.tradeId, payerTx, sellerTx);

  return buildPublicClaimsJson({
    tradeId: input.tradeId,
    chain: input.chain,
    claims: { payer: payerClaims, seller: sellerClaims },
    chainFacts,
    anchor: input.anchors ?? { payer: null, seller: null },
  });
}