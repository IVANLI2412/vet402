export type RepresentativeTxRow = {
  attempted_at?: string | Date;
  delivered?: boolean;
  tx_hash?: string | null;
  network?: string | null;
};

function attemptedAtMs(row: RepresentativeTxRow): string {
  if (row.attempted_at instanceof Date) return row.attempted_at.toISOString();
  return String(row.attempted_at ?? "");
}

function agentChainCaip(agentCaip: string | undefined): string | undefined {
  if (typeof agentCaip !== "string" || !agentCaip.startsWith("eip155:")) return undefined;
  const parts = agentCaip.split(":");
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return undefined;
}

function rowNetworkCaip(network: string | null | undefined): string | undefined {
  if (typeof network !== "string" || !network.trim()) return undefined;
  const t = network.trim();
  if (t.startsWith("eip155:")) return t.split(":").length >= 2 ? `eip155:${t.split(":")[1]}` : t;
  if (t === "base") return "eip155:8453";
  return t;
}

function rowOnAgentChain(row: RepresentativeTxRow, agentChain: string | undefined): boolean {
  if (!agentChain) return true;
  const net = rowNetworkCaip(row.network);
  if (!net) return true;
  return net === agentChain;
}

function hasTxHash(row: RepresentativeTxRow): boolean {
  return typeof row.tx_hash === "string" && row.tx_hash.trim().length > 0;
}

/**
 * Earliest delivered on the agent chain, then earliest delivered on any chain,
 * then earliest row with a tx hash (vet402 weekly rollup / proofOfPayment).
 */
export function pickRepresentativeTxRow<T extends RepresentativeTxRow>(
  rows: readonly T[],
  agentCaip?: string,
  isDelivered?: (row: T) => boolean,
): T | null {
  const agentChain = agentChainCaip(agentCaip);
  const withHash = rows.filter(hasTxHash);
  const sorted = [...withHash].sort((a, b) => attemptedAtMs(a).localeCompare(attemptedAtMs(b)));
  const delivered = (row: T) => (isDelivered ? isDelivered(row) : !!row.delivered);

  for (const row of sorted) {
    if (delivered(row) && rowOnAgentChain(row, agentChain)) return row;
  }
  for (const row of sorted) {
    if (delivered(row)) return row;
  }
  return sorted[0] ?? null;
}