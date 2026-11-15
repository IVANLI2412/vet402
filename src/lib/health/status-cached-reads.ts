// ============================================================
// /status の集計読み取りキャッシュ（2026-11-16 pmf85 PAGES・F1）。
// ルート layout の nonce で頁は動的のまま、DB 読みだけ Data Cache に載せる。
// unstable_cache は JSON なので Date は ISO 文字列で預け、取り出すときに Date へ戻す。
// ============================================================
import { unstable_cache } from "next/cache";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { readChainFreshness, type ChainFreshness } from "@/lib/health/chain-freshness";
import { getStatusHistory, type HealthStatus, type StatusHistory } from "@/lib/health/snapshot";

export type StatusHistoryRead = StatusHistory & { readAt: string };
export type ChainFreshnessRead = { rows: ChainFreshness[] | null; readAt: string };

type CachedChainFreshness = Omit<ChainFreshness, "lastIndexedAt"> & { lastIndexedAt: string | null };
type ChainFreshnessCachedPayload = { rows: CachedChainFreshness[]; readAt: string };

export function chainFreshnessToCache(rows: ChainFreshness[]): CachedChainFreshness[] {
  return rows.map((r) => ({ ...r, lastIndexedAt: r.lastIndexedAt ? r.lastIndexedAt.toISOString() : null }));
}

export function chainFreshnessFromCache(rows: CachedChainFreshness[]): ChainFreshness[] {
  return rows.map((r) => ({ ...r, lastIndexedAt: r.lastIndexedAt ? new Date(r.lastIndexedAt) : null }));
}

type StoredStatusHistory = Omit<StatusHistory, "current" | "monitoringSince"> & {
  current: { status: HealthStatus; checkedAt: string } | null;
  monitoringSince: string | null;
};

function statusHistoryToStored(history: StatusHistory): StoredStatusHistory {
  return {
    days: history.days,
    unreadable: history.unreadable,
    current: history.current
      ? { status: history.current.status, checkedAt: history.current.checkedAt.toISOString() }
      : null,
    monitoringSince: history.monitoringSince ? history.monitoringSince.toISOString() : null,
  };
}

function statusHistoryFromStored(stored: StoredStatusHistory): StatusHistory {
  return {
    days: stored.days,
    unreadable: stored.unreadable,
    current: stored.current
      ? { status: stored.current.status, checkedAt: new Date(stored.current.checkedAt) }
      : null,
    monitoringSince: stored.monitoringSince ? new Date(stored.monitoringSince) : null,
  };
}

const statusHistoryCached = unstable_cache(
  async (): Promise<{ stored: StoredStatusHistory; readAt: string }> => {
    const readAt = new Date().toISOString();
    const history = await getStatusHistory(30);
    if (history.unreadable) throw new Error("status-history-unreadable");
    return { stored: statusHistoryToStored(history), readAt };
  },
  ["health:status-history:30d:v2"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["health"] },
);

export async function getStatusHistoryCached(_windowDays = 30): Promise<StatusHistoryRead> {
  void _windowDays;
  try {
    const { stored, readAt } = await statusHistoryCached();
    return { ...statusHistoryFromStored(stored), readAt };
  } catch {
    const readAt = new Date().toISOString();
    const history = await getStatusHistory(30);
    return { ...history, readAt };
  }
}

const chainFreshnessCached = unstable_cache(
  async (): Promise<ChainFreshnessCachedPayload> => {
    const readAt = new Date().toISOString();
    const rows = await readChainFreshness();
    if (rows === null) throw new Error("chain-freshness-unreadable");
    return { rows: chainFreshnessToCache(rows), readAt };
  },
  ["health:chain-freshness:v2"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["health"] },
);

export async function getChainFreshnessCached(): Promise<ChainFreshnessRead> {
  try {
    const cached = await chainFreshnessCached();
    return {
      rows: cached.rows ? chainFreshnessFromCache(cached.rows) : null,
      readAt: cached.readAt,
    };
  } catch {
    const readAt = new Date().toISOString();
    const rows = await readChainFreshness();
    return { rows, readAt };
  }
}