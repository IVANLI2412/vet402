import { chainById, isChainEnabled } from "@/lib/chain/chains";
import {
  BASE_USDC_EIP712_NAME,
  BASE_USDC_EIP712_VERSION,
  EVM_PAY_CHAINS,
  evmChainFor,
  isEvmPayChainEnabled,
  type EvmPayChain,
} from "@/lib/observatory/x402-payer";
import {
  classifyPaymentNetwork,
  isReadableTx,
  readPaymentOnChain,
  type PaymentProofReaders,
} from "@/lib/payment-proof/chain";
import { lookupL1PurchaseNetwork } from "./l1-purchase-network";
import { isVet402HostedFeedbackUri } from "./vet402-feedback-uri";

/** Mainnet USDC for rollup tx probe on Ethereum (eip155:1); not an L1 signing lane. */
export const ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

export const ETHEREUM_ROLLUP_CHAIN: EvmPayChain = {
  caip2: "eip155:1",
  chainId: 1,
  usdc: ETHEREUM_USDC,
  eip712Name: BASE_USDC_EIP712_NAME,
  eip712Version: BASE_USDC_EIP712_VERSION,
  label: "Ethereum",
  v1Slug: null,
  flagEnv: null,
  requiredEnv: "ETHEREUM_RPC_URL",
};

const ROLLUP_PROBE_TABLE: readonly EvmPayChain[] = [...EVM_PAY_CHAINS, ETHEREUM_ROLLUP_CHAIN];

function rollupChainEnabled(chain: EvmPayChain): boolean {
  if (chain.chainId === 1) {
    const row = chainById(1);
    return row !== null && isChainEnabled(row);
  }
  const pinned = EVM_PAY_CHAINS.find((c) => c.caip2 === chain.caip2);
  if (!pinned) return false;
  return isEvmPayChainEnabled(pinned);
}

/** Enabled EVM chains vet402 reads for purchases, agent chain first. */
export function rollupEvmProbeOrder(agentCaip: string | undefined): EvmPayChain[] {
  const agentNetwork =
    typeof agentCaip === "string" && agentCaip.startsWith("eip155:")
      ? `eip155:${agentCaip.split(":")[1]}`
      : "eip155:8453";
  const enabled = ROLLUP_PROBE_TABLE.filter(rollupChainEnabled);
  const agentRow = evmChainFor(agentNetwork) ?? (agentNetwork === ETHEREUM_ROLLUP_CHAIN.caip2 ? ETHEREUM_ROLLUP_CHAIN : null);
  const ordered: EvmPayChain[] = [];
  if (agentRow && enabled.some((c) => c.caip2 === agentRow.caip2)) ordered.push(agentRow);
  for (const chain of enabled) {
    if (agentRow && chain.caip2 === agentRow.caip2) continue;
    ordered.push(chain);
  }
  return ordered;
}

export type RollupProbeResult =
  | { kind: "found"; caip: string; movement: Awaited<ReturnType<typeof readPaymentOnChain>> }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export type RollupProbeContext = {
  feedbackUri?: string;
  lookupPurchaseNetwork?: (txHash: string) => Promise<string | null>;
};

type TryRead =
  | { tag: "found"; caip: string; movement: Awaited<ReturnType<typeof readPaymentOnChain>> }
  | { tag: "not_found" }
  | { tag: "unavailable" }
  | { tag: "skip" };

async function tryReadOnNetwork(
  caip: string,
  txHash: string,
  payer: string | null,
  readers: PaymentProofReaders | undefined,
): Promise<TryRead> {
  const classified = classifyPaymentNetwork(caip);
  if (classified.kind !== "supported" || !isReadableTx(txHash, classified.network)) return { tag: "skip" };
  const movement = await readPaymentOnChain(classified.network, txHash, payer, readers);
  if (movement.state === "confirmed" || movement.state === "failed") {
    return { tag: "found", caip: classified.network.caip, movement };
  }
  if (movement.state === "not_found") return { tag: "not_found" };
  return { tag: "unavailable" };
}

/** Try enabled chains (payment-proof reader) until a receipt exists (confirmed or failed). */
export async function probeRollupPaymentTx(
  txHash: string,
  payer: string | null,
  agentCaip: string | undefined,
  readers: PaymentProofReaders | undefined,
  ctx?: RollupProbeContext,
): Promise<RollupProbeResult> {
  const hash = txHash.trim();
  const feedbackUri = ctx?.feedbackUri?.trim();
  const lookup = ctx?.lookupPurchaseNetwork ?? lookupL1PurchaseNetwork;

  let pinnedNotFound = false;
  let pinnedUnavailable = false;
  if (feedbackUri && isVet402HostedFeedbackUri(feedbackUri)) {
    let dbNetwork: string | null = null;
    try {
      dbNetwork = await lookup(hash);
    } catch {
      dbNetwork = null;
    }
    if (dbNetwork) {
      const pinned = await tryReadOnNetwork(dbNetwork, hash, payer, readers);
      if (pinned.tag === "found") return { kind: "found", caip: pinned.caip, movement: pinned.movement };
      // 見つからない・読めないときも、ほかの網を順に試す（2026-11-18 第三者点検）。結果が無ければ下で同じ判定に落ちる。
      if (pinned.tag === "not_found") pinnedNotFound = true;
      if (pinned.tag === "unavailable") pinnedUnavailable = true;
    }
  }

  const order = rollupEvmProbeOrder(agentCaip);
  if (order.length === 0) return pinnedNotFound ? { kind: "not_found" } : { kind: "unavailable" };
  let sawNotFound = pinnedNotFound;
  let sawUnavailable = pinnedUnavailable;
  for (const chain of order) {
    const tried = await tryReadOnNetwork(chain.caip2, hash, payer, readers);
    if (tried.tag === "found") return { kind: "found", caip: tried.caip, movement: tried.movement };
    if (tried.tag === "not_found") sawNotFound = true;
    if (tried.tag === "unavailable") sawUnavailable = true;
  }
  if (sawNotFound) return { kind: "not_found" };
  if (sawUnavailable) return { kind: "unavailable" };
  return { kind: "not_found" };
}