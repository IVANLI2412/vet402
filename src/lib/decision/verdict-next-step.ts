/** Plain-language next step after ALLOW / WARN / BLOCK (home paste and MCP check_x402_seller). */
export function verdictNextStep(recommendation: "ALLOW" | "WARN" | "BLOCK"): string {
  if (recommendation === "ALLOW") {
    return "vet402 paid it recently and got the content. Your own spending cap still applies.";
  }
  if (recommendation === "WARN") {
    return "Do not pay yet. See why below.";
  }
  return "Do not pay.";
}