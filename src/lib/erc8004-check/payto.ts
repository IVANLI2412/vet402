import { type Address, zeroAddress } from "viem";
import { fetchAgentIdentity } from "@/lib/chain/erc8004";
import { ERC8004_INDEXED_CHAIN, getErc8004MatchCached } from "@/lib/observatory/erc8004-match";

export type AgentPayTargets = {
  owner: string | null;
  agentWallet: string | null;
  vet402PayTo: string | null;
  matchKind: "owner" | "agent_wallet" | null;
  /** vet402 の購入対応表を読め、かつこの agent の行があった。 */
  vet402IndexedPayTo: boolean;
};

export async function resolveAgentPayTargets(agentId: bigint, chainId: number): Promise<AgentPayTargets> {
  const identity = await fetchAgentIdentity(agentId, chainId);
  const owner = identity.owner && identity.owner !== zeroAddress ? identity.owner.toLowerCase() : null;
  const agentWallet = identity.agentWallet ? identity.agentWallet.toLowerCase() : null;

  let vet402PayTo: string | null = null;
  let matchKind: AgentPayTargets["matchKind"] = null;
  let vet402IndexedPayTo = false;
  try {
    const match = await getErc8004MatchCached();
    if (match.status === "ok") {
      const agentKey = agentId.toString();
      const row = match.matches.find((m) => m.agentId === agentKey && m.chainId === ERC8004_INDEXED_CHAIN);
      if (row) {
        vet402PayTo = row.payTo.toLowerCase();
        matchKind = row.matchKind;
        vet402IndexedPayTo = true;
      }
    }
  } catch {
    // state unavailable — chain identity only
  }

  return { owner, agentWallet, vet402PayTo, matchKind, vet402IndexedPayTo };
}

function normalizePayeeRef(addr: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim()) ? addr.trim().toLowerCase() : addr.trim();
}

export function addressInPayTargets(to: string | null, targets: AgentPayTargets): boolean {
  if (!to) return false;
  const want = normalizePayeeRef(to);
  const pool: string[] = [];
  if (targets.vet402PayTo) pool.push(targets.vet402PayTo);
  if (targets.owner) pool.push(targets.owner);
  if (targets.agentWallet) pool.push(targets.agentWallet);
  return pool.some((entry) => normalizePayeeRef(entry) === want);
}