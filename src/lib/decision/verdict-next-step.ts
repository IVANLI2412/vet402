/** Plain-language next step after ALLOW / WARN / BLOCK (home paste and MCP check_x402_seller). ADVICE §4. */
export function verdictNextStep(
  recommendation: "ALLOW" | "WARN" | "BLOCK",
  reasonCodes?: readonly string[],
): string {
  if (recommendation === "ALLOW") {
    return "Pay only if what you are about to send matches this record: same recipient, network, and amount. Payment can still fail after you pay.";
  }
  if (recommendation === "WARN") {
    if (reasonCodes?.includes("l1_latest_failed")) {
      return "The latest paid call to this seller failed. Do not pay until a newer delivery is on record.";
    }
    return "Treat this as uncertain. The record is old or incomplete. Pay only under your own ceiling, or pick another URL.";
  }
  return "Do not pay this URL on the current record.";
}

export const NO_RECORD_NEXT =
  "This is not a BLOCK. It means vet402 has not paid it yet." as const;