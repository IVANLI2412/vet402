// ============================================================
// check_concordium_agent（2026-11-22・ハッカソン戦略の作業依頼 WORK_ORDERS 5 行目）。
//
// Concordium の CIS-8004 agent（token id か口座）について、vet402-concordium の /check を 1 回読み、
// badge の状態・vet402 の判定（go / no / unproven）・trust_summary の 1 行・記録の URL だけを写して返す。
// 読むだけ。支払い・署名・鍵は使わない。送るのは agent と caller の 2 つだけ（呼び手の情報は送らない）。
// 試験網（Concordium testnet）の結果であることを応答に必ず載せる。
// 届かない・遅い・形が違う時は concordium_unavailable を返し、vet402 の DB の障害（503）には数えない。
// ============================================================
import { z } from "zod";
import { OUTPUT_TEXT } from "./text";

export const CONCORDIUM_CHECK_ORIGIN = "https://vet402-concordium.fly.dev";
export const CONCORDIUM_CALLER = "vet402.com-mcp";
/** /check の初回は実測 2 秒前後。MCP の 1 回の応答に収めるため 8 秒で切る。 */
export const CONCORDIUM_TIMEOUT_MS = 8_000;
export const CONCORDIUM_NETWORK = "concordium-testnet";

/** token id（10 進）か Concordium の口座（base58、50 字前後）。 */
const AGENT_RE = /^(?:\d{1,20}|[1-9A-HJ-NP-Za-km-z]{48,56})$/;

export function isConcordiumAgent(raw: string): boolean {
  return AGENT_RE.test(raw.trim());
}

const upstreamSchema = z.object({
  agent: z.string(),
  check_badge: z.object({ status: z.string() }).passthrough(),
  vet402: z.object({ verdict: z.string(), reason: z.string().optional() }).passthrough(),
  evidence_record_url: z.string().nullable().optional(),
  checked_at: z.string().optional(),
  trust_summary: z.object({ line: z.string() }).passthrough().optional(),
});

export type ConcordiumAgentOut = {
  agent: string;
  network: typeof CONCORDIUM_NETWORK;
  badge_status: string;
  verdict: "go" | "no" | "unproven";
  reason: string | null;
  trust_summary: string | null;
  row_url: string | null;
  checked_at: string | null;
  source_url: string;
  note: string;
};

const CONCORDIUM_NOTE = OUTPUT_TEXT.concordium_note;

function verdictOf(raw: string): "go" | "no" | "unproven" {
  return raw === "go" || raw === "no" ? raw : "unproven";
}

function httpsOrNull(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

export async function checkConcordiumAgent(
  agent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConcordiumAgentOut | "unavailable"> {
  const url = `${CONCORDIUM_CHECK_ORIGIN}/check?agent=${encodeURIComponent(agent)}&caller=${encodeURIComponent(CONCORDIUM_CALLER)}`;
  let body: unknown;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CONCORDIUM_TIMEOUT_MS),
    });
    if (!res.ok) return "unavailable";
    body = await res.json();
  } catch {
    return "unavailable";
  }
  const parsed = upstreamSchema.safeParse(body);
  if (!parsed.success) return "unavailable";
  const d = parsed.data;
  return {
    agent: d.agent.slice(0, 64),
    network: CONCORDIUM_NETWORK,
    badge_status: d.check_badge.status.slice(0, 32),
    verdict: verdictOf(d.vet402.verdict),
    reason: typeof d.vet402.reason === "string" ? d.vet402.reason.slice(0, 200) : null,
    trust_summary: d.trust_summary?.line ? d.trust_summary.line.slice(0, 200) : null,
    row_url: httpsOrNull(d.evidence_record_url),
    checked_at: typeof d.checked_at === "string" ? d.checked_at.slice(0, 40) : null,
    source_url: url,
    note: CONCORDIUM_NOTE,
  };
}
