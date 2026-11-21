/** Human-readable network filters for /observatory (values match networkFilterIds). */
export const OBSERVATORY_NETWORK_OPTIONS = [
  { value: "", label: "All chains" },
  { value: "base", label: "Base", hint: "eip155:8453" },
  { value: "solana", label: "Solana", hint: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  { value: "stellar", label: "Stellar", hint: "stellar:pubnet" },
  { value: "eip155:5042", label: "Arc", hint: "eip155:5042" },
  { value: "eip155:42220", label: "Celo", hint: "eip155:42220" },
  { value: "eip155:42161", label: "Arbitrum", hint: "eip155:42161" },
] as const;

export function observatoryNetworkSelectValue(network: string | null): string {
  if (!network) return "";
  const n = network.trim().toLowerCase();
  for (const opt of OBSERVATORY_NETWORK_OPTIONS) {
    if (!opt.value) continue;
    if (opt.value.toLowerCase() === n || opt.hint?.toLowerCase() === n) return opt.value;
  }
  return network;
}