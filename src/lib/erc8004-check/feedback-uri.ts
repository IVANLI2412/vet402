import { safeFetch } from "@/lib/net/safe-fetch";
import { keccak256, toBytes, type Hex } from "viem";
import { pickRepresentativeTxRow } from "./representative-tx";

const IPFS_GATEWAY = "https://cloudflare-ipfs.com/ipfs/";
const URI_TIMEOUT_MS = 5_000;

export type FeedbackUriReader = (uri: string, signal: AbortSignal) => Promise<{ body: string; contentType: string | null }>;

async function defaultFetch(uri: string, signal: AbortSignal): Promise<{ body: string; contentType: string | null }> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("invalid_data_uri");
    const meta = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    // data: もチェーンに誰でも書ける。デコードの前に大きさで断る（base64 は 4 文字で 3 バイト）。
    // 1 バイトは base64 で 4/3 文字、percent-encoding で最大 3 文字。デコード後も上限で断る。
    const maxChars = meta.includes(";base64") ? Math.ceil((FEEDBACK_URI_MAX_BYTES * 4) / 3) + 4 : FEEDBACK_URI_MAX_BYTES * 3;
    if (payload.length > maxChars) throw new Error("too_large");
    const body =
      meta.includes(";base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
    if (Buffer.byteLength(body, "utf8") > FEEDBACK_URI_MAX_BYTES) throw new Error("too_large");
    return { body, contentType: meta.split(";")[0] || "text/plain" };
  }

  let url = uri;
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    url = `${IPFS_GATEWAY}${path}`;
  }

  assertPublicHttpsUrl(url);
  // 宛先の検査と接続先の固定（名前の引き直しで内部へ向ける手を塞ぐ）は既存の safeFetch に任せる。リダイレクトは追わない。
  const response = await safeFetch(url, { signal }, { httpsOnly: true, maxRedirects: 0 });
  if (response.status >= 300 && response.status < 400) throw new Error("redirect_refused");
  if (!response.ok) throw new Error(`http_${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > FEEDBACK_URI_MAX_BYTES) throw new Error("too_large");
  return { body: await readCapped(response, FEEDBACK_URI_MAX_BYTES), contentType: response.headers.get("content-type") };
}

/** 本文を上限まで読み、超えたら読むのをやめて断る（Content-Length を偽られても全部は読まない）。 */
async function readCapped(response: Response, cap: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}


/** feedbackURI の本文の上限（2026-11-18）。 */
export const FEEDBACK_URI_MAX_BYTES = 256 * 1024;

/**
 * feedbackURI はチェーンに誰でも書ける。サーバーが取りに行くのは https の公開の宛先だけ（2026-11-18）。
 * localhost・IP の直書き（私用・ループバック・リンクローカル・メタデータを含む全部）・ポート指定・認証情報つきは断る。
 */
export function assertPublicHttpsUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid_uri");
  }
  if (u.protocol !== "https:") throw new Error("uri_scheme_refused");
  if (u.username || u.password) throw new Error("uri_credentials_refused");
  if (u.port && u.port !== "443") throw new Error("uri_port_refused");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("uri_host_refused");
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) throw new Error("uri_ip_literal_refused");
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

export type RollupTransactionRow = {
  tx_hash?: string | null;
  delivered?: boolean;
  attempted_at?: string;
  network?: string;
};

/** vet402 weekly rollup JSON (schema + transactions[], no top-level proofOfPayment). */
export function isVet402WeeklyRollup(parsed: unknown): boolean {
  const root = asRecord(parsed);
  if (!root) return false;
  if (root.schema !== "ars-evidence/0.1") return false;
  if (!Array.isArray(root.transactions)) return false;
  return typeof root.week === "string" && root.week.length > 0;
}

function chainFromAgentCaip(agentCaip: unknown): string | undefined {
  if (typeof agentCaip !== "string" || !agentCaip.startsWith("eip155:")) return undefined;
  const parts = agentCaip.split(":");
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return undefined;
}

export function extractRollupTransactionProof(parsed: unknown): ProofOfPayment | null {
  if (!isVet402WeeklyRollup(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const txs = root.transactions as RollupTransactionRow[];
  const row = pickRepresentativeTxRow(txs, typeof root.agentCaip === "string" ? root.agentCaip : undefined);
  if (!row?.tx_hash?.trim()) return null;
  const net = row.network?.trim();
  return {
    txHash: row.tx_hash.trim(),
    chain: (net && net.startsWith("eip155:") ? net : chainFromAgentCaip(root.agentCaip)) ?? "eip155:8453",
    asset: "USDC",
    token: "USDC",
  };
}

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