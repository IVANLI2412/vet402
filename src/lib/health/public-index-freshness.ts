/**
 * Public settlements-index freshness (2026-11-21 persona P2 W5).
 *
 * /api/health answers whether vet402 can respond. /status section 2 lists each
 * chain in a table. Monitors and the status headline need the same numbers in a
 * compact form, computed only from the chain-freshness read (public checkpoints
 * and chain block timestamps), never from admin fields.
 */

import { CHAIN_READ_TIMEOUT_MS, readChainFreshness, type ChainFreshness } from "@/lib/health/chain-freshness";

/** Budget for attaching freshness to a liveness response (several chains, memoized). */
export const PUBLIC_INDEX_READ_BUDGET_MS = CHAIN_READ_TIMEOUT_MS + 500;

export type PublicSettlementsIndexChain = {
  label: string;
  network: string;
  /** Gap between checkpoint and tip block timestamps, in seconds. */
  secondsBehind?: number;
  /** When secondsBehind is not published (not indexed yet, per payee, not read). */
  note?: string;
};

export type PublicSettlementsIndex = {
  readAt: string;
  chains: PublicSettlementsIndexChain[];
};

function fmtPublicLag(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3_600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

export function publicSettlementsIndexOf(rows: ChainFreshness[], readAt: string): PublicSettlementsIndex {
  const chains: PublicSettlementsIndexChain[] = rows.map((row) => {
    const entry: PublicSettlementsIndexChain = { label: row.label, network: row.network };
    if (row.secondsBehind !== null && row.secondsBehind > 0) {
      entry.secondsBehind = row.secondsBehind;
    } else if (row.note && row.note !== "chain not read") {
      entry.note = row.note;
    }
    return entry;
  });
  return { readAt, chains };
}

/** One sentence for /status section 1, beside the service status (ok / stale / …). */
export function settlementsIndexHeadline(summary: PublicSettlementsIndex): string {
  const parts: string[] = [];
  for (const c of summary.chains) {
    if (typeof c.secondsBehind === "number" && c.secondsBehind > 0) {
      parts.push(`${c.label} ${fmtPublicLag(c.secondsBehind)} behind the newest block`);
    } else if (c.note === "not indexed yet") {
      parts.push(`${c.label} not indexed yet`);
    }
  }
  if (parts.length === 0) {
    return "Settlements index: no measured lag on the chains listed in section 2.";
  }
  return `Settlements index: ${parts.join(". ")}.`;
}

function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Best-effort read for GET /api/health: omit on timeout or unreadable, never fail liveness. */
export async function readPublicSettlementsIndex(): Promise<PublicSettlementsIndex | undefined> {
  try {
    const rows = await withBudget(readChainFreshness(), PUBLIC_INDEX_READ_BUDGET_MS);
    if (rows === null) return undefined;
    return publicSettlementsIndexOf(rows, new Date().toISOString());
  } catch {
    return undefined;
  }
}