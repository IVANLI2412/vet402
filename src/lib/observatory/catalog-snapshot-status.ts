import { SNAPSHOT_ONLY_SOURCES } from "./listing-sources";

export type CatalogSnapshotRow = {
  source: string;
  snapshotDate: string;
  totalCount: number;
  fetchedCount: number;
  complete?: boolean | null;
  cursorPassCompleted?: boolean;
  status?: CatalogSnapshotStatus;
  snapshotOnly?: boolean;
};

const SNAPSHOT_ONLY = new Set<string>(SNAPSHOT_ONLY_SOURCES.map((s) => s.source));

export type CatalogSnapshotStatus = "complete" | "partial" | "fetch_failed";

export function catalogSnapshotStatus(input: {
  complete?: boolean | null;
  fetchedCount: number;
  totalCount: number;
}): CatalogSnapshotStatus {
  if (input.complete === false && input.fetchedCount === 0) return "fetch_failed";
  if (input.complete === false || (input.complete === null && input.fetchedCount < input.totalCount)) return "partial";
  return "complete";
}

export function enrichCatalogSnapshot(row: CatalogSnapshotRow): CatalogSnapshotRow {
  return {
    ...row,
    status: catalogSnapshotStatus(row),
    snapshotOnly: SNAPSHOT_ONLY.has(row.source),
  };
}

export type PublicCatalogSnapshot = {
  source: string;
  snapshotDate: string | null;
  totalCount: number | null;
  fetchedCount: number | null;
  complete?: boolean | null;
  status?: CatalogSnapshotStatus | "not_yet_read";
  snapshotOnly?: boolean;
  cursorPassCompleted?: boolean;
};

export function publicCatalogSnapshots(rows: CatalogSnapshotRow[]): PublicCatalogSnapshot[] {
  const bySource = new Map(rows.map((r) => [r.source, enrichCatalogSnapshot(r)]));
  const out: PublicCatalogSnapshot[] = [];
  for (const [, e] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const status = e.status ?? catalogSnapshotStatus(e);
    if (status === "fetch_failed") {
      out.push({
        ...e,
        status,
        totalCount: null,
        fetchedCount: null,
      });
    } else {
      out.push({ ...e, status });
    }
  }
  for (const s of SNAPSHOT_ONLY_SOURCES) {
    if (!bySource.has(s.source)) {
      out.push({
        source: s.source,
        status: "not_yet_read",
        snapshotDate: null,
        totalCount: null,
        fetchedCount: null,
        snapshotOnly: true,
      });
    }
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}