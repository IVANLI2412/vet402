import { SIGNING_DOMAIN } from "@/lib/verify-message";

export const TRADE_DISPUTE_CHAIN = "eip155:84532";

export type PayerClaimDelivery = "none" | "received";
export type SellerClaimDelivery = "none" | "delivered";
export type SellerPaymentSeen = "yes" | "no";

export function formatBodySha256(hash: string | null): string {
  if (hash === null) return "none";
  return hash.toLowerCase();
}

export function parseBodySha256Field(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === "none") return null;
  if (!/^[0-9a-f]{64}$/.test(v)) return null;
  return v;
}

export function tradeDisputeLegSignMessage(input: {
  tradeId: string;
  side: "payer";
  paymentTx: string;
  delivery: PayerClaimDelivery;
  receivedBodySha256: string | null;
  issued: string;
}): string;
export function tradeDisputeLegSignMessage(input: {
  tradeId: string;
  side: "seller";
  paymentTx: string;
  paymentSeen: SellerPaymentSeen;
  delivery: SellerClaimDelivery;
  deliveredBodySha256: string | null;
  issued: string;
}): string;
export function tradeDisputeLegSignMessage(
  input:
    | {
        tradeId: string;
        side: "payer";
        paymentTx: string;
        delivery: PayerClaimDelivery;
        receivedBodySha256: string | null;
        issued: string;
      }
    | {
        tradeId: string;
        side: "seller";
        paymentTx: string;
        paymentSeen: SellerPaymentSeen;
        delivery: SellerClaimDelivery;
        deliveredBodySha256: string | null;
        issued: string;
      },
): string {
  const head = [
    `${SIGNING_DOMAIN} trade claim v1`,
    `domain: ${SIGNING_DOMAIN}`,
    `trade_id: ${input.tradeId.toLowerCase()}`,
    `chain: ${TRADE_DISPUTE_CHAIN}`,
    `side: ${input.side}`,
    `payment_tx: ${input.paymentTx.toLowerCase()}`,
  ];
  if (input.side === "payer") {
    head.push(
      `delivery: ${input.delivery}`,
      `received_body_sha256: ${formatBodySha256(input.receivedBodySha256)}`,
      `issued: ${input.issued}`,
      "This signature does not move funds.",
    );
  } else {
    head.push(
      `payment_seen: ${input.paymentSeen}`,
      `delivery: ${input.delivery}`,
      `delivered_body_sha256: ${formatBodySha256(input.deliveredBodySha256)}`,
      `issued: ${input.issued}`,
      "This signature does not move funds.",
    );
  }
  return head.join("\n");
}

export function tradeDisputeDeliveryReceiptMessage(input: {
  tradeId: string;
  bodySha256: string;
  issued: string;
}): string {
  return [
    `${SIGNING_DOMAIN} trade delivery receipt`,
    `domain: ${SIGNING_DOMAIN}`,
    `trade_id: ${input.tradeId.toLowerCase()}`,
    `chain: ${TRADE_DISPUTE_CHAIN}`,
    `body_sha256: ${input.bodySha256.toLowerCase()}`,
    `issued: ${input.issued}`,
    "This signature does not move funds.",
  ].join("\n");
}