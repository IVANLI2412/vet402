import type { ChainFactsJson, PublicClaimsJson } from "@/lib/observatory/trade-dispute";

export type TradeDisputePanelJson = PublicClaimsJson;

export type TradeDisputeDisplayRow = { label: string; value: string };

function panelScalar(value: string | null | undefined): string {
  return value ?? "none";
}

function summarizeSide(side: "payer" | "seller", json: PublicClaimsJson): string {
  const leg = json.claims[side].current;
  if (!leg) return "none";
  if (side === "payer") {
    return `delivery ${leg.delivery}`;
  }
  return `payment_seen ${leg.paymentSeen ?? "none"}, delivery ${leg.delivery}`;
}

function historyRows(side: "payer" | "seller", json: PublicClaimsJson): TradeDisputeDisplayRow[] {
  return json.claims[side].history.map((leg) => ({
    label: side === "payer" ? "Payer earlier claim" : "Seller earlier claim",
    value: `Earlier claim signed at ${leg.issued}: delivery ${leg.delivery}`,
  }));
}

function formatAuthorizeTimestamp(blockTimestamp: number): string {
  const iso = new Date(blockTimestamp * 1000).toISOString();
  return `${blockTimestamp} (${iso})`;
}

function paymentStateRows(state: ChainFactsJson["paymentState"]): TradeDisputeDisplayRow[] {
  if (!state) {
    return [
      { label: "Payment state collected", value: "none" },
      { label: "Payment state capturable", value: "none" },
      { label: "Payment state refundable", value: "none" },
    ];
  }
  return [
    { label: "Payment state collected", value: String(state.hasCollectedPayment) },
    { label: "Payment state capturable", value: state.capturableAmount },
    { label: "Payment state refundable", value: state.refundableAmount },
  ];
}

function namedTxRows(namedTxs: ChainFactsJson["namedTxs"]): TradeDisputeDisplayRow[] {
  return namedTxs.map((tx, index) => ({
    label: `Named tx ${index + 1} match`,
    value: `${tx.hash} ${tx.match}`,
  }));
}

/** Public claims JSON を Connect パネル表示行に射影する（純粋関数）。 */
export function tradeDisputeDisplayRows(json: TradeDisputePanelJson): TradeDisputeDisplayRow[] {
  const cf = json.chainFacts;
  const rows: TradeDisputeDisplayRow[] = [
    { label: "Trade id", value: json.tradeId },
    { label: "Record kind", value: json.recordKind },
    { label: "Payer current", value: summarizeSide("payer", json) },
    ...historyRows("payer", json),
    { label: "Seller current", value: summarizeSide("seller", json) },
    ...historyRows("seller", json),
    { label: "Chain facts status", value: cf.status },
    { label: "Read at block", value: panelScalar(cf.readAtBlock) },
    { label: "Authorize tx hash", value: panelScalar(cf.authorizeTx?.hash) },
    { label: "Authorize tx block number", value: cf.authorizeTx ? String(cf.authorizeTx.blockNumber) : "none" },
    {
      label: "Authorize tx block timestamp",
      value: cf.authorizeTx ? formatAuthorizeTimestamp(cf.authorizeTx.blockTimestamp) : "none",
    },
    { label: "Authorize tx status", value: panelScalar(cf.authorizeTx?.status) },
    { label: "Authorize amount", value: panelScalar(cf.amount) },
    { label: "Payment info token", value: panelScalar(cf.paymentInfo?.token) },
    ...paymentStateRows(cf.paymentState),
    ...namedTxRows(cf.namedTxs),
    { label: "Note", value: json.note },
  ];

  if (cf.status === "unmatched" && cf.readAtBlock) {
    rows.push({
      label: "Chain match note",
      value: `vet402 could not match a named transaction to this tradeId at block ${cf.readAtBlock}`,
    });
  }
  if (cf.status === "unavailable") {
    rows.push({
      label: "Chain read note",
      value: "vet402 could not read the chain at this response",
    });
  }

  return rows;
}