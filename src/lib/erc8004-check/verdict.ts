import { isAddress } from "viem";
import type { AgentPayTargets } from "./payto";
import type { Erc8004CheckChecks, Erc8004CheckMismatchReason, Erc8004CheckTriState, Erc8004CheckVerdict } from "./types";

const STELLAR_ADDR = /^G[A-Z2-7]{55}$|^C[A-Z0-9]{55}$/;

export function feedbackAddressKind(addr: string): "evm" | "stellar" | "other" {
  const t = addr.trim();
  if (isAddress(t)) return "evm";
  if (STELLAR_ADDR.test(t)) return "stellar";
  return "other";
}

export function addressesEqual(a: string, b: string): boolean {
  const ak = feedbackAddressKind(a);
  const bk = feedbackAddressKind(b);
  if (ak === "evm" && bk === "evm") return a.toLowerCase() === b.toLowerCase();
  if (ak === "stellar" && bk === "stellar") return a === b;
  return a === b;
}

/** Writer (client) とチェーン上の payer が同じ名前空間で照合できるか。 */
export function payerLinkable(client: string, from: string | null): boolean {
  if (!from) return false;
  return feedbackAddressKind(client) === feedbackAddressKind(from);
}

export function triFromMatchesClient(client: string, from: string | null): Erc8004CheckTriState {
  if (!from) return "unknown";
  if (!payerLinkable(client, from)) return "unknown";
  return addressesEqual(client, from) ? "pass" : "fail";
}

export type PaymentNetworkKind = "evm" | "tempo" | "solana" | "xrpl" | "stellar" | "unsupported";

export function evaluateRecipientCheck(
  movementTo: string | null,
  proofTo: string | null,
  paymentKind: PaymentNetworkKind,
  inPayTargets: (to: string | null) => boolean,
  payTargets?: Pick<AgentPayTargets, "vet402IndexedPayTo">,
): Erc8004CheckTriState {
  const c = classifyRecipient(movementTo, proofTo, paymentKind, inPayTargets, payTargets);
  return c === "unconfirmed" ? "unknown" : c;
}

/**
 * evaluateRecipientCheck と同じ判定に、「対応表に行が無いので fail と言えないだけで、
 * 宛先は owner でも agentWallet でもない」を "unconfirmed" として足したもの。
 * unconfirmed の支払いは verified の語で通さない（11/22 証明の監査 whitehat-R5-3 / adversary-N3）。
 */
export function classifyRecipient(
  movementTo: string | null,
  proofTo: string | null,
  paymentKind: PaymentNetworkKind,
  inPayTargets: (to: string | null) => boolean,
  payTargets?: Pick<AgentPayTargets, "vet402IndexedPayTo">,
): Erc8004CheckTriState | "unconfirmed" {
  // pass は取引から読んだ宛先の一致だけ。feedback の本文が名乗る宛先（proofTo）だけでは pass にしない
  // （11/22 証明の監査2 whitehat 中1。申告を owner にして別の住所へ払った取引で verified が出ていた）。
  if (inPayTargets(movementTo)) return "pass";
  if (!movementTo) return "unknown";
  if (paymentKind !== "evm" && paymentKind !== "tempo") {
    if (proofTo && addressesEqual(movementTo, proofTo)) return "unknown";
  }
  const canAssertMismatch = payTargets?.vet402IndexedPayTo === true;
  return canAssertMismatch ? "fail" : "unconfirmed";
}

function mismatchReasons(checks: Erc8004CheckChecks): Erc8004CheckMismatchReason[] {
  const reasons: Erc8004CheckMismatchReason[] = [];
  if (checks.feedback_hash === "fail") reasons.push("feedback_hash");
  if (checks.tx_exists === "fail") reasons.push("tx_not_found");
  if (checks.to_matches_agent_payTo_or_wallet === "fail") reasons.push("recipient");
  if (checks.amount === "fail") reasons.push("amount");
  if (checks.token === "fail") reasons.push("token");
  return reasons;
}

export function decideVerdict(
  checks: Erc8004CheckChecks,
  hadPayment: boolean,
  opts: { recipientUnconfirmed?: boolean } = {},
): { verdict: Erc8004CheckVerdict; reasons?: Erc8004CheckMismatchReason[] } {
  const hardMismatch = mismatchReasons(checks);
  if (hardMismatch.length > 0) {
    return { verdict: "mismatch", reasons: hardMismatch };
  }

  const paymentConfirmed =
    checks.tx_exists === "pass" || (hadPayment && checks.tx_exists !== "fail");

  const verifiedCore =
    checks.feedback_hash === "pass" &&
    paymentConfirmed &&
    checks.to_matches_agent_payTo_or_wallet === "pass" &&
    checks.amount === "pass" &&
    checks.token === "pass" &&
    checks.from_matches_client === "pass";

  if (verifiedCore) {
    return { verdict: "verified" };
  }

  if (checks.feedback_hash !== "pass") {
    return { verdict: "mismatch", reasons: ["feedback_hash"] };
  }

  const paymentNotWrong =
    checks.tx_exists !== "fail" &&
    checks.to_matches_agent_payTo_or_wallet !== "fail" &&
    checks.amount !== "fail" &&
    checks.token !== "fail";

  // 宛先が owner でも agentWallet でもないのに対応表に行が無いだけの支払いは、verified の語で通さない（fail でもない）。
  if (paymentNotWrong && opts.recipientUnconfirmed === true && (paymentConfirmed || checks.tx_exists === "unknown")) {
    return { verdict: "payment_recipient_unverified" };
  }

  if (paymentNotWrong && paymentConfirmed && checks.from_matches_client !== "pass") {
    return { verdict: "verified_payment_unlinked_client" };
  }

  if (
    paymentNotWrong &&
    (paymentConfirmed || checks.tx_exists === "unknown") &&
    (checks.to_matches_agent_payTo_or_wallet === "unknown" || checks.from_matches_client !== "pass")
  ) {
    return { verdict: "verified_payment_unlinked_client" };
  }

  return { verdict: "mismatch", reasons: ["tx_not_found"] };
}