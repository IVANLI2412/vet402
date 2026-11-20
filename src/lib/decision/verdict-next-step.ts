/** Plain-language next step after ALLOW / WARN / BLOCK (home paste and MCP check_x402_seller). ADVICE §4. */
export function verdictNextStep(recommendation: "ALLOW" | "WARN" | "BLOCK"): string {
  if (recommendation === "ALLOW") {
    return "Pay only if the 402 in hand matches the verified terms of this record. A later payment can still fail.";
  }
  if (recommendation === "WARN") {
    return "Do not treat this as a go. Evidence is old or inconclusive. Pay only under your own ceiling, or pick another URL.";
  }
  return "Do not pay this URL on the current record.";
}

export const NO_RECORD_NEXT =
  "This is not a BLOCK. It means vet402 has not paid it yet." as const;