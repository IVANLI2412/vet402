import { keccak256, toBytes, type Hex } from "viem";

const IPFS_GATEWAY = "https://cloudflare-ipfs.com/ipfs/";
const URI_TIMEOUT_MS = 5_000;

export type FeedbackUriReader = (uri: string, signal: AbortSignal) => Promise<{ body: string; contentType: string | null }>;

async function defaultFetch(uri: string, signal: AbortSignal): Promise<{ body: string; contentType: string | null }> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("invalid_data_uri");
    const meta = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    const body =
      meta.includes(";base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
    return { body, contentType: meta.split(";")[0] || "text/plain" };
  }

  let url = uri;
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    url = `${IPFS_GATEWAY}${path}`;
  }

  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const body = await response.text();
  return { body, contentType: response.headers.get("content-type") };
}

export async function readFeedbackUri(
  uri: string,
  reader: FeedbackUriReader = defaultFetch,
  timeoutMs = URI_TIMEOUT_MS,
): Promise<{ body: string; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await reader(uri, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function hashFeedbackBody(body: string): Hex {
  return keccak256(toBytes(body));
}

export type ProofOfPayment = {
  txHash?: string;
  chain?: string;
  chainId?: number | string;
  from?: string;
  fromAddress?: string;
  to?: string;
  toAddress?: string;
  amount?: string | number;
  asset?: string;
  token?: string;
};

export function extractProofOfPayment(parsed: unknown): ProofOfPayment | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const raw = record.proofOfPayment ?? record.proof_of_payment;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const proof = raw as Record<string, unknown>;
  const txHash = pickString(proof, ["txHash", "tx_hash", "transaction", "transactionHash"]);
  if (!txHash) return null;
  return {
    txHash,
    chain: pickString(proof, ["chain", "network", "caip2"]),
    chainId: pickChainId(proof),
    from: pickString(proof, ["from", "fromAddress", "from_address", "payer"]),
    to: pickString(proof, ["to", "toAddress", "to_address", "payee"]),
    amount: pickAmount(proof),
    asset: pickString(proof, ["asset", "token", "currency"]),
    token: pickString(proof, ["token", "asset"]),
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function pickChainId(obj: Record<string, unknown>): number | string | undefined {
  const raw = obj.chainId ?? obj.chain_id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return undefined;
}

function pickAmount(obj: Record<string, unknown>): string | undefined {
  const raw = obj.amount ?? obj.value ?? obj.amount_atomic;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function payeesFromObject(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  const out: string[] = [];
  for (const key of ["pay_to", "payTo", "payee", "to", "toAddress"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

/** フィードバック本文に載ったエージェント側の受け手（Stellar payTo など）。 */
export function declaredAgentPayees(parsed: unknown): string[] {
  const root = asRecord(parsed);
  if (!root) return [];
  const set = new Set<string>();
  for (const key of ["seller", "payee"]) {
    for (const payee of payeesFromObject(asRecord(root[key]))) set.add(payee);
  }
  const lumi = asRecord(root.lumiReceipt);
  if (lumi) {
    for (const payee of payeesFromObject(asRecord(lumi.seller))) set.add(payee);
  }
  return [...set];
}

/** proofOfPayment に無い amount / asset / to を Lumi 等の本文から補う。 */
export function enrichProofFromFeedback(parsed: unknown, proof: ProofOfPayment): ProofOfPayment {
  const root = asRecord(parsed);
  if (!root) return proof;
  const next: ProofOfPayment = { ...proof };
  const lumi = asRecord(root.lumiReceipt);
  const payment = asRecord(lumi?.payment);
  if (!next.amount && payment) {
    const atomic = payment.amount_atomic;
    if (typeof atomic === "number" && Number.isFinite(atomic)) next.amount = String(Math.trunc(atomic));
    else if (typeof atomic === "string" && atomic.trim()) next.amount = atomic.trim();
    else {
      const amount = pickAmount(payment);
      if (amount) next.amount = amount;
    }
  }
  if (!next.asset) {
    const asset = pickString(payment ?? {}, ["asset", "token"]);
    if (asset) next.asset = asset;
  }
  if (!next.to && !next.toAddress) {
    const seller = asRecord(lumi?.seller) ?? asRecord(root.seller);
    const to = pickString(seller ?? {}, ["pay_to", "payTo", "payee"]);
    if (to) next.to = to;
  }
  return next;
}