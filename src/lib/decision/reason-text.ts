// ============================================================
// 理由コードごとの英語1文（公開面・2026-11-15）。
// 正典は REASON_CODES の code キーと完全一致。meaning は使わない。
// ============================================================
import { REASON_CODES, reasonCodeDocOf } from "./reason-codes";

export const REASON_TEXT: Readonly<Record<string, string>> = {
  l0_pass: "The latest probe returned a valid HTTP 402 payment request from this URL.",
  l0_fail: "Two probes in a row returned no valid HTTP 402 payment request.",
  l0_unverified:
    "vet402 has not measured a valid HTTP 402 recently, and a companion code names why when vet402 recorded one.",
  l0_unverified_single_fail:
    "The latest probe failed once while the published rule waits for two failures in a row.",
  l0_unverified_no_recent_probe:
    "vet402 probed this listing before but not in the last 30 days, so this answer does not rest on a recent probe.",
  "l0_unverified_<cause>":
    "vet402 could not measure a valid HTTP 402 from this URL, and the code names the cause such as not_probed, tls or path_template.",
  l1_delivered:
    "vet402 recorded a non-empty 2xx other than 202 Accepted on a paid test within the 30 day window.",
  l1_not_attempted: "vet402 has not signed a paid attempt against this URL.",
  l1_stale:
    "The last delivery vet402 recorded is older than 30 days or the last signed attempt falls outside the window.",
  l1_inconclusive:
    "vet402 signed paid attempts in the window but none count toward delivery or a seller-side failure.",
  l1_never_delivered:
    "Counted failures sit in the window and no delivery appears on record at any age.",
  l1_paid_not_delivered:
    "After the last delivery in the window, or in the window when there was none, a payment moved on chain and no delivery came back.",
  l1_latest_failed:
    "Something was delivered before, but the latest counted attempt failed.",
  l1_empty_2xx_settlement_unknown:
    "After the last delivery, or in the window when there was none, a paid attempt brought nothing back and it is not yet known whether money moved.",
  l1_not_counted_vet402_side:
    "Some attempts are left out because the record shows vet402's side of the fault.",
  l1_not_counted_held:
    "Some attempts are left out while held or while a receipt awaits on chain verification.",
  l1_not_counted_no_charge:
    "Some attempts are left out because the seller answered without taking a payment.",
  l1_not_counted_unproven:
    "Some attempts are left out because vet402 cannot show the failure was not its own.",
  l1_not_counted_unconfirmed:
    "A seller-side failure has been seen on one UTC day so far and needs a second day to count.",
  l1_waived_by_operator:
    "The caller passed allow_without_l1, so missing or old L1 evidence does not hold back an ALLOW.",
  l2_conform: "The latest delivered body has the keys the output declaration for this URL requires.",
  l2_conform_no_required_keys:
    "The latest delivered body matched a declaration that marks no key as required, so vet402 checked only that the body is a JSON object or array.",
  l2_undeclared:
    "Neither the catalog nor the purchase row of the latest delivery gives an output declaration to check against.",
  l2_not_checked:
    "An output declaration exists for this URL but vet402 has not checked a delivered body against it.",
  l2_mismatch: "The latest delivered body did not match the output declaration for this URL.",
  l2_mismatch_unexplained:
    "A mismatch is on record without named missing keys, so vet402 cannot say what differed.",
  offer_drifting: "The price, asset, or payTo changed three or more times within 24 hours.",
  wash_dominated:
    "Real payments are 10 percent or less of at least 10 settlements to this seller from payers other than vet402 and listed measurement services in the 30 day window.",
  dialect_mismatch: "The HTTP 402 speaks a different x402 version than the caller_dialect you sent.",
  data_thin: "Little data sits behind this answer, and the public route does not set this code today.",
  operator_blacklist: "The counterparty is on the caller's own block list for keyed calls.",
  sybil_high:
    "The payer shares an owner with several agents and a funder with other payers.",
  retry_burst:
    "This code was retired with the 2026-11-02 rules and current answers do not carry it.",
  "<input>_unavailable":
    "A payee input could not be read, for example settlements or funder_index, so the answer stays BLOCK.",
  thin_history: "The payer has two or fewer settled payments in 30 days.",
  shared_funder: "The payer wallet was funded by the same address as other payers.",
  new_payer: "vet402 first saw this payer less than 7 days ago.",
  erc8004_registered: "The payer is registered as an ERC-8004 agent on chain.",
  history_ok: "None of the payee checks fired, and the funder index covers few wallets, so this does not show that the payer is independent.",
};

// REASON_CODES とキー集合を揃える（テストが固定）。
void REASON_CODES;

export function reasonTextOf(code: string): string | null {
  const doc = reasonCodeDocOf(code);
  if (!doc) return null;
  return REASON_TEXT[doc.code] ?? null;
}