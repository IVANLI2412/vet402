import type { FindListing } from "@/lib/find/reads";

export const FIND_MIN_DELIVERED_RATE = 0.8;
export const FIND_MAX_ALTERNATIVES = 3;
export const FIND_POOL_SIZE = 25;
export const FIND_WINDOW_DAYS = 30;

const WILSON_Z = 1.96;

export function sameListingUrl(a: string, b: string): boolean {
  const norm = (u: string): string | null => {
    try {
      const p = new URL(u);
      const host = p.host.toLowerCase();
      let path = p.pathname;
      if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
      return `${host}${path}`;
    } catch {
      return null;
    }
  };
  const na = norm(a);
  const nb = norm(b);
  return na !== null && na === nb;
}

export function wilsonLower(delivered: number, attempts: number): number {
  if (attempts <= 0) return 0;
  const p = delivered / attempts;
  const n = attempts;
  const z2 = WILSON_Z * WILSON_Z;
  const radicand = (p * (1 - p) + z2 / (4 * n)) / n;
  const num = p + z2 / (2 * n) - WILSON_Z * Math.sqrt(Math.max(0, radicand));
  const den = 1 + z2 / n;
  return num / den;
}

function cmpListing(a: FindListing, b: FindListing): number {
  const wa = wilsonLower(a.delivered30d, a.paidAttempts30d);
  const wb = wilsonLower(b.delivered30d, b.paidAttempts30d);
  if (wb !== wa) return wb - wa;
  if (b.delivered30d !== a.delivered30d) return b.delivered30d - a.delivered30d;
  const ta = a.lastAttemptAt ? Date.parse(a.lastAttemptAt) : 0;
  const tb = b.lastAttemptAt ? Date.parse(b.lastAttemptAt) : 0;
  if (tb !== ta) return tb - ta;
  return a.resourceKey.localeCompare(b.resourceKey);
}

export type RankDropped = { noPaidTest: number; lowRate: number; sameUrl: number };

export type RankResult = {
  alternatives: FindListing[];
  dropped: RankDropped;
};

export function rankFindAlternatives(
  pool: FindListing[],
  excludeUrl: string | null,
  maxAlternatives: number = FIND_MAX_ALTERNATIVES,
): RankResult {
  const dropped: RankDropped = { noPaidTest: 0, lowRate: 0, sameUrl: 0 };
  const byResourceKey = new Map<string, FindListing>();
  for (const s of pool) {
    const key = s.resourceKey.toLowerCase();
    const prev = byResourceKey.get(key);
    if (!prev) {
      byResourceKey.set(key, s);
      continue;
    }
    if (wilsonLower(s.delivered30d, s.paidAttempts30d) > wilsonLower(prev.delivered30d, prev.paidAttempts30d)) {
      byResourceKey.set(key, s);
    }
  }
  const unique = [...byResourceKey.values()];

  const eligible: FindListing[] = [];
  for (const s of unique) {
    if (excludeUrl && sameListingUrl(s.url, excludeUrl)) {
      dropped.sameUrl++;
      continue;
    }
    if (s.paidAttempts30d < 1) {
      dropped.noPaidTest++;
      continue;
    }
    const rate = s.delivered30d / s.paidAttempts30d;
    if (rate < FIND_MIN_DELIVERED_RATE) {
      dropped.lowRate++;
      continue;
    }
    eligible.push(s);
  }

  eligible.sort(cmpListing);
  const cap = Math.max(1, Math.min(maxAlternatives, eligible.length));
  return {
    alternatives: eligible.slice(0, cap),
    dropped,
  };
}