// ============================================================
// 理由コードの効き目・根拠・配達の鮮度（純関数・DB なし・2026-11-15）。
// ============================================================
import { explorerTxUrl } from "@/lib/observatory/chains";
import { reasonCodeDocOf } from "./reason-codes";
import { reasonTextOf } from "./reason-text";
import { blockReasonCodes, L1_FRESH_DAYS, type L1Basis } from "./rules";
import type { SellerFacts, VerifiedTerms } from "./types";

export type ReasonEffectKind = "sets_block" | "caps_at_warn" | "none";
export type ReasonEvidenceRef = {
  kind: "purchase" | "tx" | "response_hash" | "declaration_hash" | "diff_hash" | "record";
  id: string | null;
  url: string | null;
};
export type ReasonExplanation = {
  code: string;
  text: string;
  effect: ReasonEffectKind;
  max_recommendation: "ALLOW" | "WARN" | "BLOCK";
  evidence_status: "linked" | "record" | "none";
  evidence: ReasonEvidenceRef[];
};
export type EvidenceAge = {
  last_delivered_at: string | null;
  days_since_last_delivery: number | null;
  last_paid_test_at: string | null;
  tier: "fresh" | "aging" | "stale" | "none";
  max_recommendation: "ALLOW" | "WARN";
  waived_by_caller: boolean;
  fresh_within_days: 7;
  stale_after_days: number;
  text: string;
};

export const EVIDENCE_FRESH_WITHIN_DAYS = 7 as const;

const SITE = "https://vet402.com";
const MISSING_TEXT = "vet402 has no sentence for this reason code yet.";

function purchasesUrl(observatoryId: string): string {
  return `${SITE}/api/v1/observatory/endpoints/${observatoryId}/purchases`;
}

function recordUrl(observatoryId: string): string {
  return `${SITE}/observatory/e/${observatoryId}`;
}

function isoDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : null;
}

function splitPurchaseId(purchaseId: string): { network: string; tx: string } | null {
  const i = purchaseId.lastIndexOf(":");
  if (i < 0) return null;
  const tx = purchaseId.slice(i + 1);
  const network = purchaseId.slice(0, i);
  if (!tx || !network) return null;
  return { network, tx };
}

function purchaseAndTxRefs(
  purchaseId: string | null | undefined,
  network: string | null | undefined,
  observatoryId: string,
): ReasonEvidenceRef[] {
  if (!purchaseId) return [];
  const out: ReasonEvidenceRef[] = [
    { kind: "purchase", id: purchaseId, url: purchasesUrl(observatoryId) },
  ];
  const parts = splitPurchaseId(purchaseId);
  const net = network ?? parts?.network ?? null;
  const tx = parts?.tx ?? null;
  if (net && tx) {
    const url = explorerTxUrl(net, tx);
    out.push({ kind: "tx", id: tx, url });
  }
  return out;
}

function evidenceStatusOf(refs: ReasonEvidenceRef[]): ReasonExplanation["evidence_status"] {
  if (refs.length === 0) return "none";
  if (refs.some((r) => r.kind !== "record")) return "linked";
  return "record";
}

function maxRecOf(effect: ReasonEffectKind): ReasonExplanation["max_recommendation"] {
  if (effect === "sets_block") return "BLOCK";
  if (effect === "caps_at_warn") return "WARN";
  return "ALLOW";
}

function effectForPayer(code: string, codes: readonly string[], basis: L1Basis | null): ReasonEffectKind {
  if (blockReasonCodes(codes, basis).includes(code)) return "sets_block";
  if (
    codes.includes("l1_waived_by_operator") &&
    (code === "l1_not_attempted" || code === "l1_stale" || code === "l1_inconclusive")
  ) {
    return "none";
  }
  const doc = reasonCodeDocOf(code);
  if (!doc) return "none";
  if (doc.effect === "WARN" || doc.effect === "WARN_OR_BLOCK") return "caps_at_warn";
  return "none";
}

function effectForPayee(code: string): ReasonEffectKind {
  const doc = reasonCodeDocOf(code);
  if (!doc) return "none";
  if (doc.effect === "BLOCK") return "sets_block";
  if (doc.effect === "WARN") return "caps_at_warn";
  return "none";
}

export function formatDaysForText(daysRaw: number): string {
  const oneDecimal = Math.round(daysRaw * 10) / 10;
  if (Number.isInteger(oneDecimal)) return String(oneDecimal);
  return oneDecimal.toFixed(1);
}

function evidenceAgeText(
  lastDeliveredAt: string | null,
  daysRaw: number | null,
  tier: EvidenceAge["tier"],
  maxRec: EvidenceAge["max_recommendation"],
): string {
  if (tier === "none") {
    return "No paid test by vet402 has returned content from this URL so far.";
  }
  const date = isoDate(lastDeliveredAt) ?? "unknown date";
  const daysStr = daysRaw === null ? "0" : formatDaysForText(daysRaw);
  const body = `Content last came back on a paid test on ${date}, ${daysStr} days before this answer`;
  if (tier === "stale" && maxRec === "WARN") {
    return `${body}, so the answer can be no better than WARN.`;
  }
  return `${body}.`;
}

export function evidenceAgeOf(
  basis: L1Basis,
  decision: { reason_codes: readonly string[] },
): EvidenceAge {
  const daysRaw = basis.days_since_last_delivery;
  const codes = decision.reason_codes;
  const staleCode = codes.includes("l1_stale");
  let tier: EvidenceAge["tier"];
  if (staleCode) {
    tier = basis.last_delivered_at ? "stale" : "none";
  } else if (!basis.last_delivered_at) {
    tier = "none";
  } else if (daysRaw !== null && daysRaw <= EVIDENCE_FRESH_WITHIN_DAYS) {
    tier = "fresh";
  } else {
    tier = "aging";
  }
  const waived = codes.includes("l1_waived_by_operator") && (tier === "stale" || tier === "none");
  const maxRec: EvidenceAge["max_recommendation"] =
    tier === "fresh" || tier === "aging" ? "ALLOW" : waived ? "ALLOW" : "WARN";
  return {
    last_delivered_at: basis.last_delivered_at,
    days_since_last_delivery: daysRaw,
    last_paid_test_at: basis.last_signed_attempt_at,
    tier,
    max_recommendation: maxRec,
    waived_by_caller: waived,
    fresh_within_days: EVIDENCE_FRESH_WITHIN_DAYS,
    stale_after_days: L1_FRESH_DAYS,
    text: evidenceAgeText(basis.last_delivered_at, daysRaw, tier, maxRec),
  };
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

function deliveryInWindow(basis: L1Basis): boolean {
  const days = basis.days_since_last_delivery;
  return days !== null && days <= basis.window_days;
}

function evidenceForCode(
  code: string,
  input: {
    basis: L1Basis | null;
    observatoryId: string;
    verifiedTerms: VerifiedTerms | null;
    l2: SellerFacts["l2"] | null;
    l2PurchaseId: string | null;
  },
): ReasonEvidenceRef[] {
  const { basis, observatoryId, verifiedTerms, l2, l2PurchaseId } = input;

  if (
    code === "l1_not_attempted" ||
    code === "l2_undeclared" ||
    code === "operator_blacklist" ||
    code === "l1_waived_by_operator"
  ) {
    return [];
  }

  if (code === "l1_delivered" || code === "l1_stale") {
    const purchasesRecord: ReasonEvidenceRef[] = [
      { kind: "record", id: null, url: purchasesUrl(observatoryId) },
    ];
    if (!basis || !verifiedTerms?.purchase_id) return purchasesRecord;
    if (!sameInstant(verifiedTerms.verified_at, basis.last_delivered_at)) return purchasesRecord;
    if (code === "l1_delivered" && !deliveryInWindow(basis)) return purchasesRecord;
    return purchaseAndTxRefs(verifiedTerms.purchase_id, verifiedTerms.network, observatoryId);
  }

  if (code.startsWith("l0_unverified")) {
    return [{ kind: "record", id: null, url: recordUrl(observatoryId) }];
  }

  if (code === "l2_conform" || code === "l2_conform_no_required_keys" || code === "l2_mismatch" || code === "l2_mismatch_unexplained") {
    if (!l2PurchaseId) {
      return [{ kind: "record", id: null, url: purchasesUrl(observatoryId) }];
    }
    const refs = purchaseAndTxRefs(l2PurchaseId, null, observatoryId);
    if (l2?.response_hash) refs.push({ kind: "response_hash", id: l2.response_hash, url: null });
    if (l2?.declaration_hash) refs.push({ kind: "declaration_hash", id: l2.declaration_hash, url: null });
    if (l2?.diff_hash) refs.push({ kind: "diff_hash", id: l2.diff_hash, url: null });
    if (refs.length === 0) {
      return [{ kind: "record", id: null, url: purchasesUrl(observatoryId) }];
    }
    return refs;
  }

  if (
    code.startsWith("l0_") ||
    code === "offer_drifting" ||
    code === "dialect_mismatch" ||
    code === "data_thin" ||
    code === "wash_dominated"
  ) {
    return [{ kind: "record", id: null, url: recordUrl(observatoryId) }];
  }

  if (
    code === "l1_paid_not_delivered" ||
    code === "l1_latest_failed" ||
    code === "l1_never_delivered" ||
    code === "l1_inconclusive" ||
    code.startsWith("l1_not_counted_") ||
    code === "l1_empty_2xx_settlement_unknown" ||
    code === "l2_not_checked"
  ) {
    return [{ kind: "record", id: null, url: purchasesUrl(observatoryId) }];
  }

  return [];
}

export function explainReasons(input: {
  codes: readonly string[];
  role: "payer" | "payee";
  basis: L1Basis | null;
  observatoryId: string;
  verifiedTerms: VerifiedTerms | null;
  l2: SellerFacts["l2"] | null;
  l2PurchaseId: string | null;
}): ReasonExplanation[] {
  return input.codes.map((code) => {
    const text = reasonTextOf(code) ?? MISSING_TEXT;
    const effect =
      input.role === "payer" ? effectForPayer(code, input.codes, input.basis) : effectForPayee(code);
    const evidence = input.role === "payee" ? [] : evidenceForCode(code, input);
    return {
      code,
      text,
      effect,
      max_recommendation: maxRecOf(effect),
      evidence_status: evidenceStatusOf(evidence),
      evidence,
    };
  });
}