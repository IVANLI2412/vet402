// ============================================================
// ERC-8004 段階 C: 鎖の外のフィードバック JSON（ars-evidence/0.1 互換）。
// 読みは DB のみ。鎖への書き込みはしない。
// ============================================================
import { createHash } from "node:crypto";
import { ERC8004_ADDRESSES } from "@/lib/chain/config";
import { heldReasonOf, isDelivered } from "@/lib/observatory/delivery";
import { l2ReadingOf } from "@/lib/observatory/l2-check";
import { sellerHostOfResourceKey } from "@/lib/sellers/host";
import { parseErc8004AgentCaip } from "@/lib/observatory/erc8004-export-agent";
import { pickRepresentativeTxRow } from "@/lib/erc8004-check/representative-tx";

export const ERC8004_FEEDBACK_SCHEMA = "ars-evidence/0.1" as const;

/**
 * Weekly JSON includes top-level proofOfPayment from this ISO week onward.
 * Weeks through 2026-W46 must stay byte-identical — on-chain feedbackHash for vet402 attestments depends on it.
 */
export const ERC8004_WEEKLY_PROOF_OF_PAYMENT_FROM_WEEK = "2026-W47" as const;

function isoWeekParts(week: string): { year: number; ww: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week.trim());
  if (!m) return null;
  const ww = Number(m[2]);
  if (ww < 1 || ww > 53) return null;
  return { year: Number(m[1]), ww };
}

export function isoWeekAtOrAfter(week: string, fromWeek: string): boolean {
  const a = isoWeekParts(week);
  const b = isoWeekParts(fromWeek);
  if (!a || !b) return false;
  if (a.year !== b.year) return a.year > b.year;
  return a.ww >= b.ww;
}

/** Representative purchase row for weekly proofOfPayment (matches erc8004-check rollup path). */
export function representativeWeeklyProofRow(
  rows: readonly PurchaseFeedbackRow[],
  agentCaip?: string,
): PurchaseFeedbackRow | null {
  return pickRepresentativeTxRow(rows, agentCaip, (r) => deliveryOutcome(r).outcome === "delivered");
}

export type Erc8004ProofOfPayment = {
  chain: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  currency: string;
};

export type Erc8004FeedbackDelivery = {
  outcome: "delivered" | "not_delivered" | "inconclusive";
  l1_status: string;
  http_status: number | null;
  l2_reading: string | null;
  latency_ms: number | null;
  observed_at: string;
  data_returned: boolean | null;
  /** vet402 側の不備の可能性がある 4xx。売り手の失点に数えない。 */
  inconclusive_held: boolean;
  held_reason: string | null;
};

export type Erc8004FeedbackDocument = {
  version: typeof ERC8004_FEEDBACK_SCHEMA;
  issued_at: string;
  receipt_id: string;
  agentCaip: string;
  matchKind: "owner" | "agent_wallet";
  endpoint: string;
  proofOfPayment: Erc8004ProofOfPayment | null;
  delivery: Erc8004FeedbackDelivery;
  vet402: {
    purchase_id: string;
    resource_key: string;
    host: string;
    methodology: string;
  };
  agentRegistry: string;
  contentSha256: string;
};

export type PurchaseFeedbackRow = {
  id: string;
  attempted_at: Date | string;
  resource_key: string;
  network: string | null;
  status: string;
  amount_units: string | null;
  spent_units: string | null;
  tx_hash: string | null;
  http_status_paid: number | null;
  latency_ms: number | null;
  l2_schema: string | null;
  l2_detail: unknown;
  l2_body_head: string | null;
  l2_content_type: string | null;
  pay_to: string | null;
  payer: string | null;
  payload_non_empty: boolean | null;
  erc8004_agent: string | null;
  erc8004_match_kind: string | null;
};

export function chainIdForNetwork(network: string | null): string {
  if (!network) return "eip155:8453";
  if (network.startsWith("eip155:")) return network;
  if (network === "base") return "eip155:8453";
  return network;
}

export function deliveryOutcome(row: PurchaseFeedbackRow): Erc8004FeedbackDelivery {
  const held = heldReasonOf({
    status: row.status,
    httpStatusPaid: row.http_status_paid,
    txHash: row.tx_hash,
    attemptedAt: row.attempted_at,
    network: row.network,
  });
  const delivered = isDelivered({
    status: row.status,
    httpStatusPaid: row.http_status_paid,
    payloadNonEmpty: row.payload_non_empty,
  });
  const l2Reading =
    row.l2_schema === null || row.l2_schema === undefined
      ? null
      : l2ReadingOf(
          {
            l2Schema: row.l2_schema,
            l2Detail: row.l2_detail,
            bodyHead: row.l2_body_head,
            contentType: row.l2_content_type,
          },
          null,
        );

  let outcome: Erc8004FeedbackDelivery["outcome"];
  if (held) outcome = "inconclusive";
  else if (delivered) outcome = "delivered";
  else outcome = "not_delivered";

  const attemptedAt =
    row.attempted_at instanceof Date ? row.attempted_at.toISOString() : new Date(row.attempted_at).toISOString();

  return {
    outcome,
    l1_status: row.status,
    http_status: row.http_status_paid,
    l2_reading: l2Reading,
    latency_ms: row.latency_ms,
    observed_at: attemptedAt,
    data_returned: row.payload_non_empty,
    inconclusive_held: held !== null,
    held_reason: held,
  };
}

export function buildProofOfPayment(row: PurchaseFeedbackRow): Erc8004ProofOfPayment | null {
  if (!row.tx_hash || !row.pay_to || !row.payer) return null;
  return {
    chain: chainIdForNetwork(row.network),
    txHash: row.tx_hash.toLowerCase(),
    fromAddress: row.payer.toLowerCase(),
    toAddress: row.pay_to.toLowerCase(),
    amount: row.spent_units ?? row.amount_units ?? "0",
    currency: "USDC",
  };
}

/** 本文 JSON（contentSha256 なし）を安定化して文字列化する。 */
export function serializeFeedbackBody(doc: Omit<Erc8004FeedbackDocument, "contentSha256">): string {
  return JSON.stringify(doc);
}

export function sha256HexUtf8(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function buildErc8004FeedbackDocument(row: PurchaseFeedbackRow, issuedAt: string): Erc8004FeedbackDocument | null {
  const agent = parseErc8004AgentCaip(row.erc8004_agent);
  if (!agent || row.erc8004_match_kind !== "owner" && row.erc8004_match_kind !== "agent_wallet") return null;

  const host = sellerHostOfResourceKey(row.resource_key);
  const withoutHash: Omit<Erc8004FeedbackDocument, "contentSha256"> = {
    version: ERC8004_FEEDBACK_SCHEMA,
    issued_at: issuedAt,
    receipt_id: `vet402-${row.id}`,
    agentCaip: row.erc8004_agent!,
    matchKind: row.erc8004_match_kind,
    endpoint: row.resource_key,
    proofOfPayment: buildProofOfPayment(row),
    delivery: deliveryOutcome(row),
    vet402: {
      purchase_id: row.id,
      resource_key: row.resource_key,
      host,
      methodology: "https://vet402.com/observatory/methodology",
    },
    agentRegistry: `eip155:8453:${ERC8004_ADDRESSES.identityRegistry.toLowerCase()}`,
  };
  const body = serializeFeedbackBody(withoutHash);
  return { ...withoutHash, contentSha256: sha256HexUtf8(body) };
}

/** ISO 週 YYYY-Www の UTC 境界 [start, end)。 */
export function isoWeekUtcBounds(week: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const w = Number(m[2]);
  if (w < 1 || w > 53) return null;
  // ISO week: Monday 00:00 UTC of week 1 contains Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(Date.UTC(year, 0, 4 - day + 1));
  const start = new Date(mondayWeek1.getTime() + (w - 1) * 7 * 86_400_000);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { start, end };
}

export function parseAgentIdParam(raw: string): { chainId: number; agentId: bigint; caip: string } | null {
  const trimmed = raw.trim();
  const caip = parseErc8004AgentCaip(trimmed.startsWith("eip155:") ? trimmed : `eip155:8453:${trimmed}`);
  if (!caip) return null;
  const chainNum = Number(caip.chain.replace("eip155:", ""));
  if (!Number.isFinite(chainNum)) return null;
  try {
    return { chainId: chainNum, agentId: BigInt(caip.agentId), caip: `eip155:${chainNum}:${caip.agentId}` };
  } catch {
    return null;
  }
}

export type Erc8004WeeklySummary = {
  schema: typeof ERC8004_FEEDBACK_SCHEMA;
  agentCaip: string;
  week: string;
  period: { from: string; to: string };
  methodology: string;
  population: { purchases: number; delivered: number; deliveredRate: number | null };
  transactions: {
    purchase_id: string;
    tx_hash: string | null;
    attempted_at: string;
    delivered: boolean;
    network?: string;
  }[];
  proofOfPayment?: Erc8004ProofOfPayment;
  contentSha256: string;
};

export function buildWeeklySummary(input: {
  agentCaip: string;
  week: string;
  period: { from: string; to: string };
  rows: PurchaseFeedbackRow[];
  issuedAt: string;
}): Erc8004WeeklySummary {
  const deliveredCount = input.rows.filter((r) => deliveryOutcome(r).outcome === "delivered").length;
  const purchases = input.rows.length;
  const withoutHash: Omit<Erc8004WeeklySummary, "contentSha256"> = {
    schema: ERC8004_FEEDBACK_SCHEMA,
    agentCaip: input.agentCaip,
    week: input.week,
    period: input.period,
    methodology: "https://vet402.com/observatory/methodology#erc8004",
    population: {
      purchases,
      delivered: deliveredCount,
      deliveredRate: purchases > 0 ? Math.round((deliveredCount / purchases) * 10_000) / 100 : null,
    },
    transactions: input.rows.map((r) => {
      const base = {
        purchase_id: r.id,
        tx_hash: r.tx_hash,
        attempted_at:
          r.attempted_at instanceof Date ? r.attempted_at.toISOString() : new Date(r.attempted_at).toISOString(),
        delivered: deliveryOutcome(r).outcome === "delivered",
      };
      if (isoWeekAtOrAfter(input.week, ERC8004_WEEKLY_PROOF_OF_PAYMENT_FROM_WEEK)) {
        return { ...base, network: chainIdForNetwork(r.network) };
      }
      return base;
    }),
  };
  if (isoWeekAtOrAfter(input.week, ERC8004_WEEKLY_PROOF_OF_PAYMENT_FROM_WEEK)) {
    const rep = representativeWeeklyProofRow(input.rows, input.agentCaip);
    const pop = rep ? buildProofOfPayment(rep) : null;
    if (pop) withoutHash.proofOfPayment = pop;
  }
  const body = JSON.stringify(withoutHash);
  return { ...withoutHash, contentSha256: sha256HexUtf8(body) };
}