/** /decision stubs aligned with SDK freshness and verified_terms gates (R3). */

export function decisionFreshness() {
  const now = Date.now();
  return {
    scoredAt: new Date(now).toISOString(),
    cacheExpiresAt: new Date(now + 300_000).toISOString(),
  };
}

export function verifiedTermsForAccept(accept) {
  return {
    pay_to: accept.payTo,
    asset: accept.asset,
    amount: accept.amount,
    network: accept.network,
    scheme: accept.scheme ?? "exact",
  };
}

export function allowDecisionBody(accept, over = {}) {
  return {
    recommendation: "ALLOW",
    reason_codes: ["l0_pass", "l1_delivered"],
    facts: {},
    evidence: [{ level: "L1", source: "vet402" }],
    degraded: false,
    rules_version: "stub",
    ...decisionFreshness(),
    verified_terms: verifiedTermsForAccept(accept),
    ...over,
  };
}