import { canonicalNetworkId } from "@/lib/observatory/chains";
import { BASE_USDC } from "@/lib/observatory/x402-payer";
import {
  classifyPaymentNetwork,
  isReadableTx,
  readPaymentOnChain,
  type PaymentProofReaders,
} from "@/lib/payment-proof/chain";
import {
  declaredAgentPayees,
  enrichProofFromFeedback,
  extractProofOfPayment,
  extractRollupTransactionProof,
  hashFeedbackBody,
  isVet402WeeklyRollup,
  readFeedbackUri,
  type FeedbackUriReader,
  type ProofOfPayment,
} from "./feedback-uri";
import { probeRollupPaymentTx } from "./rollup-probe";
import { ledgerUnitsToExactStroops } from "@/lib/observatory/settlement-verify-stellar";
import { STELLAR_USDC_ISSUER, STELLAR_USDC_SAC } from "@/lib/observatory/stellar402-payer";
import { addressInPayTargets, resolveAgentPayTargets, type AgentPayTargets } from "./payto";
import {
  decideVerdict,
  evaluateRecipientCheck,
  payerLinkable,
  triFromMatchesClient,
  type PaymentNetworkKind,
} from "./verdict";
import {
  ERC8004_CHECK_CHAIN,
  findFeedbackLog,
  parseAgentIdParam,
  parseClientParam,
  parseErc8004Chain,
  parseFeedbackIndexParam,
  readOnChainFeedbackMeta,
  resolveClientForIndex,
  resolveFeedbackIndex,
  type RegistryReaders,
} from "./registry-read";
import type {
  Erc8004CheckChecks,
  Erc8004CheckProofSource,
  Erc8004CheckResult,
  Erc8004CheckTriState,
  Erc8004CheckVerdict,
} from "./types";

export type Erc8004CheckInput = {
  chain?: string | null;
  agentId?: string | null;
  client?: string | null;
  feedbackIndex?: string | null;
};

export type Erc8004CheckDeps = {
  now?: () => Date;
  readers?: RegistryReaders;
  paymentReaders?: PaymentProofReaders;
  fetchFeedbackUri?: FeedbackUriReader;
  resolvePayTargets?: (agentId: bigint, chainId: number) => Promise<AgentPayTargets>;
  findFeedbackLog?: typeof findFeedbackLog;
  lookupPurchaseNetwork?: (txHash: string) => Promise<string | null>;
};

export type Erc8004CheckError =
  | "invalid_chain"
  | "invalid_agent_id"
  | "missing_client_or_index"
  | "invalid_client"
  | "invalid_feedback_index"
  | "feedback_not_found";

const EMPTY_CHECKS: Erc8004CheckChecks = {
  tx_exists: "unknown",
  to_matches_agent_payTo_or_wallet: "unknown",
  from_matches_client: "unknown",
  amount: "unknown",
  token: "unknown",
  block_time: "unknown",
  feedback_hash: "unknown",
};

export async function runErc8004Check(
  input: Erc8004CheckInput,
  deps?: Erc8004CheckDeps,
): Promise<Erc8004CheckResult | { error: Erc8004CheckError }> {
  const chain = parseErc8004Chain(input.chain ?? null);
  if (!chain.ok) return { error: "invalid_chain" };

  const agentId = parseAgentIdParam(input.agentId ?? null);
  if (agentId === null) return { error: "invalid_agent_id" };

  const clientParam = parseClientParam(input.client ?? null);
  if (input.client && clientParam === null) return { error: "invalid_client" };

  const indexParam = parseFeedbackIndexParam(input.feedbackIndex ?? null);
  if (input.feedbackIndex && indexParam === null) return { error: "invalid_feedback_index" };

  if (!clientParam && indexParam === null) return { error: "missing_client_or_index" };

  const rpc = deps?.readers?.publicClient;

  let client = clientParam;
  let feedbackIndex = indexParam;

  if (client && feedbackIndex === null) {
    const last = await resolveFeedbackIndex(agentId, client, chain.chainId, rpc);
    if (last === null) return { error: "feedback_not_found" };
    feedbackIndex = last;
  }

  if (!client && feedbackIndex !== null) {
    const resolved = await resolveClientForIndex(agentId, feedbackIndex, chain.chainId, rpc);
    if (!resolved) return { error: "feedback_not_found" };
    client = resolved;
  }

  if (!client || feedbackIndex === null) return { error: "feedback_not_found" };

  const sources: Erc8004CheckResult["sources"] = [];
  const meta = await readOnChainFeedbackMeta(agentId, client, feedbackIndex, chain.chainId, rpc);
  sources.push({
    kind: "reputation_registry",
    detail: `readFeedback agent=${agentId} client=${client} index=${feedbackIndex}`,
  });

  const loadLog = deps?.findFeedbackLog ?? findFeedbackLog;
  const log = await loadLog(agentId, client, feedbackIndex, chain.chainId, deps?.readers);
  if (!log) return { error: "feedback_not_found" };
  sources.push({
    kind: "new_feedback_log",
    detail: log.txHash ? `tx=${log.txHash}` : "getLogs",
  });

  const payTargets = deps?.resolvePayTargets
    ? await deps.resolvePayTargets(agentId, chain.chainId)
  : await resolveAgentPayTargets(agentId, chain.chainId);
  sources.push({ kind: "identity_registry", detail: "owner/agentWallet" });
  if (payTargets.vet402PayTo) {
    sources.push({
      kind: "vet402_erc8004_match",
      detail: `payTo=${payTargets.vet402PayTo} kind=${payTargets.matchKind ?? "owner"}`,
    });
  }

  const reader = deps?.fetchFeedbackUri;
  let body: string;
  try {
    const fetched = await readFeedbackUri(log.feedbackURI, reader);
    body = fetched.body;
    sources.push({ kind: "feedback_uri", detail: log.feedbackURI.slice(0, 120) });
  } catch {
    return baseResult({
      verdict: "unreadable",
      chain,
      agentId,
      client,
      feedbackIndex,
      log,
      meta,
      proof: null,
      checks: { ...EMPTY_CHECKS, feedback_hash: "unknown" },
      sources,
      deps,
    });
  }

  const checks: Erc8004CheckChecks = { ...EMPTY_CHECKS };
  const bodyHash = hashFeedbackBody(body);
  checks.feedback_hash = bodyHash.toLowerCase() === String(log.feedbackHash).toLowerCase() ? "pass" : "fail";
  if (checks.feedback_hash === "fail") {
    let proof: ProofOfPayment | null = null;
    try {
      const p = JSON.parse(body) as unknown;
      proof = extractProofOfPayment(p);
    } catch {
      proof = null;
    }
    return baseResult({
      verdict: "mismatch",
      reasons: ["feedback_hash"],
      chain,
      agentId,
      client,
      feedbackIndex,
      log,
      meta,
      proof,
      checks,
      sources,
      deps,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return baseResult({
      verdict: "unreadable",
      chain,
      agentId,
      client,
      feedbackIndex,
      log,
      meta,
      proof: null,
      checks,
      sources,
      deps,
    });
  }

  let proof = extractProofOfPayment(parsed);
  let proofSource: Erc8004CheckProofSource | undefined;
  if (proof?.txHash) {
    proofSource = "proofOfPayment";
  } else {
    proof = extractRollupTransactionProof(parsed);
    if (proof?.txHash) proofSource = "rollup_transactions";
  }
  if (!proof?.txHash) {
    return baseResult({
      verdict: "no_proof",
      chain,
      agentId,
      client,
      feedbackIndex,
      log,
      meta,
      proof: null,
      checks,
      sources,
      deps,
    });
  }
  if (proofSource) checks.proof_source = proofSource;

  proof = enrichProofFromFeedback(parsed, proof);
  const declaredPayees = declaredAgentPayees(parsed);
  const rollupRoot = isVet402WeeklyRollup(parsed) ? (parsed as Record<string, unknown>) : null;
  const agentCaip = rollupRoot && typeof rollupRoot.agentCaip === "string" ? rollupRoot.agentCaip : undefined;
  const paymentCheck = await verifyProofOnChain(
    proof,
    client,
    payTargets,
    declaredPayees,
    checks,
    sources,
    deps?.paymentReaders,
    proofSource === "rollup_transactions"
      ? {
          rollup: true,
          agentCaip,
          feedbackUri: log.feedbackURI,
          lookupPurchaseNetwork: deps?.lookupPurchaseNetwork,
        }
      : undefined,
  );
  if (paymentCheck.unreadable) {
    return baseResult({
      verdict: "unreadable",
      unreadable_reason: "proof_tx_not_found_on_known_chains",
      chain,
      agentId,
      client,
      feedbackIndex,
      log,
      meta,
      proof,
      checks,
      sources,
      deps,
    });
  }
  if (paymentCheck.resolvedChain) {
    proof = { ...proof, chain: paymentCheck.resolvedChain };
    checks.proof_chain = paymentCheck.resolvedChain;
  }
  const decided = decideVerdict(checks, paymentCheck.hadPayment);
  return baseResult({
    verdict: decided.verdict,
    reasons: decided.reasons,
    chain,
    agentId,
    client,
    feedbackIndex,
    log,
    meta,
    proof,
    checks,
    sources,
    deps,
  });
}

type VerifyProofOptions = {
  rollup?: boolean;
  agentCaip?: string;
  feedbackUri?: string;
  lookupPurchaseNetwork?: (txHash: string) => Promise<string | null>;
};

async function verifyProofOnChain(
  proof: ProofOfPayment,
  client: string,
  payTargets: Awaited<ReturnType<typeof resolveAgentPayTargets>>,
  declaredPayees: string[],
  checks: Erc8004CheckChecks,
  sources: Erc8004CheckResult["sources"],
  readers?: PaymentProofReaders,
  options?: VerifyProofOptions,
): Promise<{ hadPayment: boolean; resolvedChain?: string; unreadable?: boolean }> {
  const proofTo = (proof.to ?? proof.toAddress ?? null)?.trim() ?? null;
  let paymentKind: PaymentNetworkKind = "unsupported";

  const declaredPayer = (proof.from ?? proof.fromAddress ?? null)?.trim() ?? null;
  let payerForRead: string | null = declaredPayer;
  if (declaredPayer && !payerLinkable(client, declaredPayer)) {
    payerForRead = null;
  }

  let classified: ReturnType<typeof classifyPaymentNetwork>;
  let movement: Awaited<ReturnType<typeof readPaymentOnChain>>;
  let resolvedChain: string | undefined;

  if (options?.rollup && proof.txHash) {
    const probe = await probeRollupPaymentTx(proof.txHash, payerForRead, options.agentCaip, readers, {
      feedbackUri: options.feedbackUri,
      lookupPurchaseNetwork: options.lookupPurchaseNetwork,
    });
    if (probe.kind === "not_found") {
      checks.tx_exists = "unknown";
      checks.to_matches_agent_payTo_or_wallet = proofTo ? (addressInPayTargets(proofTo, payTargets) ? "pass" : "unknown") : "unknown";
      checks.from_matches_client = "unknown";
      return { hadPayment: false, unreadable: true };
    }
    if (probe.kind === "unavailable") {
      checks.tx_exists = "unknown";
      checks.to_matches_agent_payTo_or_wallet = "unknown";
      checks.from_matches_client = "unknown";
      return { hadPayment: false, unreadable: true };
    }
    resolvedChain = probe.caip;
    classified = classifyPaymentNetwork(probe.caip);
    movement = probe.movement;
    sources.push({
      kind: "payment_chain",
      detail: `rollup_probe ${probe.caip} tx=${proof.txHash}`,
    });
  } else {
    const networkRaw = proof.chain ?? (proof.chainId !== undefined ? networkFromChainId(proof.chainId) : ERC8004_CHECK_CHAIN);
    classified = classifyPaymentNetwork(networkRaw ?? ERC8004_CHECK_CHAIN);
    if (classified.kind !== "supported" || !isReadableTx(proof.txHash!, classified.network)) {
      checks.tx_exists = proof.txHash ? "unknown" : "fail";
      checks.to_matches_agent_payTo_or_wallet = proofTo ? (addressInPayTargets(proofTo, payTargets) ? "pass" : "unknown") : "unknown";
      checks.from_matches_client = "unknown";
      return { hadPayment: false };
    }
    movement = await readPaymentOnChain(classified.network, proof.txHash!, payerForRead, readers);
    sources.push({
      kind: "payment_chain",
      detail: `${classified.network.kind} tx=${proof.txHash}`,
    });
  }

  if (classified.kind !== "supported") {
    checks.tx_exists = "unknown";
    return { hadPayment: false, resolvedChain };
  }

  paymentKind = classified.network.kind;

  if (movement.state === "not_found") checks.tx_exists = "fail";
  else if (movement.state === "confirmed") checks.tx_exists = "pass";
  else if (movement.state === "failed") checks.tx_exists = "fail";
  else checks.tx_exists = "unknown";

  checks.block_time = movement.block ? "pass" : movement.state === "confirmed" ? "unknown" : "unknown";

  checks.from_matches_client = triFromMatchesClient(client, movement.from);

  checks.to_matches_agent_payTo_or_wallet = evaluateRecipientCheck(
    movement.to,
    proofTo,
    paymentKind,
    (to) => addressInPayTargets(to, payTargets),
    declaredPayees,
  );

  checks.amount = comparePaymentAmount(proof.amount, movement.amount, paymentKind);

  // 2026-11-18: 代表の支払いが Base 以外（Arc・Arbitrum など）のとき、"USDC" の記号は Base の USDC ではなくその網の USDC と照らす。
  const declaredAsset = (proof.asset ?? proof.token ?? "").trim();
  const chainUsdc =
    classified.network.kind === "evm" ? (classified.network as { chain?: { usdc?: string } }).chain?.usdc ?? null : null;
  const expectedAsset = (
    /^0x[0-9a-fA-F]{40}$/.test(declaredAsset) ? declaredAsset : chainUsdc ?? (declaredAsset || BASE_USDC)
  ).toLowerCase();
  if (movement.asset) {
    checks.token = paymentAssetsMatch(expectedAsset, movement.asset, paymentKind) ? "pass" : "fail";
  }

  return { hadPayment: movement.state === "confirmed", resolvedChain };
}

function networkFromChainId(chainId: number | string): string {
  if (typeof chainId === "string" && chainId.startsWith("eip155:")) return canonicalNetworkId(chainId);
  if (typeof chainId === "number") return `eip155:${chainId}`;
  return ERC8004_CHECK_CHAIN;
}

function baseResult(args: {
  verdict: Erc8004CheckVerdict;
  reasons?: import("./types").Erc8004CheckMismatchReason[];
  unreadable_reason?: import("./types").Erc8004CheckUnreadableReason;
  chain: { caip: string };
  agentId: bigint;
  client: string;
  feedbackIndex: bigint;
  log: NonNullable<Awaited<ReturnType<typeof findFeedbackLog>>>;
  meta: Awaited<ReturnType<typeof readOnChainFeedbackMeta>>;
  proof: ProofOfPayment | null;
  checks: Erc8004CheckChecks;
  sources: Erc8004CheckResult["sources"];
  deps?: Erc8004CheckDeps;
}): Erc8004CheckResult {
  return {
    verdict: args.verdict,
    ...(args.reasons?.length ? { reasons: args.reasons } : {}),
    ...(args.unreadable_reason ? { unreadable_reason: args.unreadable_reason } : {}),
    chain: args.chain.caip,
    agentId: args.agentId.toString(),
    clientAddress: args.client,
    feedbackIndex: args.feedbackIndex.toString(),
    feedback: {
      value: args.log.value.toString(),
      valueDecimals: args.log.valueDecimals,
      tag1: args.meta.tag1 || args.log.tag1,
      tag2: args.meta.tag2 || args.log.tag2,
      endpoint: args.log.endpoint,
      feedbackURI: args.log.feedbackURI,
      feedbackHash: args.log.feedbackHash,
    },
    proofOfPayment: args.proof,
    checks: args.checks,
    sources: args.sources,
    as_of: (args.deps?.now ?? (() => new Date()))().toISOString(),
  };
}

export function triStateOk(v: Erc8004CheckTriState): boolean {
  return v === "pass";
}

function comparePaymentAmount(
  proofAmount: string | number | undefined,
  movementAmount: string | null,
  paymentKind: PaymentNetworkKind,
): Erc8004CheckTriState {
  if (!proofAmount) return movementAmount ? "unknown" : "unknown";
  const proof = String(proofAmount);
  if (!movementAmount) return "unknown";
  if (proof === movementAmount) return "pass";
  if (paymentKind === "stellar") {
    const stroops = ledgerUnitsToExactStroops(proof);
    if (stroops !== null && stroops.toString() === movementAmount) return "pass";
  }
  return "fail";
}

function paymentAssetsMatch(expected: string, onChain: string, paymentKind: PaymentNetworkKind): boolean {
  const chain = onChain.toLowerCase();
  const want = expected.toLowerCase();
  if (chain === want || chain === BASE_USDC.toLowerCase()) return true;
  if (paymentKind === "stellar" && isStellarUsdcOnChain(chain) && (want === "usdc" || want.includes("usdc"))) return true;
  return false;
}

function isStellarUsdcOnChain(asset: string): boolean {
  const lower = asset.toLowerCase();
  return (
    lower.includes("usdc") &&
    (lower.includes(STELLAR_USDC_ISSUER.toLowerCase()) || lower.includes(STELLAR_USDC_SAC.toLowerCase()))
  );
}