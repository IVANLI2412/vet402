"use server";

import { getCoverageShareCached, getObservatoryOverviewCached } from "@/lib/observatory/cached-reads";
import type { CoverageShare } from "@/lib/observatory/reader";
import type { PlaygroundCandidate } from "./playground-client";

export type PlaygroundCatalogLoad = {
  candidates: PlaygroundCandidate[];
  coverage: (CoverageShare & { readAt: string }) | null;
};

/** ライブデモ用の候補と coverage。初回描画では待たず、ボタン後に呼ぶ。 */
export async function loadPlaygroundCatalog(): Promise<PlaygroundCatalogLoad> {
  const [overview, coverage] = await Promise.all([
    getObservatoryOverviewCached({ verdict: "pass", pageSize: 20 }),
    getCoverageShareCached().catch(() => null),
  ]);
  const candidates: PlaygroundCandidate[] = overview.rows.map((r) => ({
    id: r.id,
    resourceKey: r.resourceKey,
    network: r.network,
    method: r.method,
  }));
  return { candidates, coverage };
}