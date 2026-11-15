// ============================================================
// E6 争いの窓口: 日次 root（commitment 昇順）。L1 canonicalDayPayload は触らない。
// ============================================================
import { createHash } from "node:crypto";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function tradeDisputeDayPayload(day: string, commitments: readonly string[]): string {
  const sorted = [...commitments].sort((a, b) => a.localeCompare(b));
  return JSON.stringify({ v: 1, kind: "e6", day, commitments: sorted });
}

export function tradeDisputeDayRootHash(prevRoot: string | null, day: string, commitments: readonly string[]): string {
  const payload = tradeDisputeDayPayload(day, commitments);
  return createHash("sha256")
    .update(prevRoot ?? "genesis", "utf8")
    .update("\n")
    .update(payload, "utf8")
    .digest("hex");
}

export function commitmentsForUtcDay(
  day: string,
  rows: readonly { commitment: string; acceptedAt: string }[],
): string[] {
  if (!DAY_RE.test(day)) return [];
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + 86_400_000;
  return rows
    .filter((r) => {
      const t = Date.parse(r.acceptedAt);
      return t >= start && t < end;
    })
    .map((r) => r.commitment);
}

export type SealTradeDisputeDayResult =
  | { status: "sealed"; day: string; rootHash: string; prevRoot: string | null; entryCount: number }
  | { status: "unchanged"; day: string; rootHash: string }
  | { status: "conflict_frozen"; day: string }
  | { status: "unavailable" };

export function recomputeTradeDisputeDayRoot(
  prevRoot: string | null,
  day: string,
  allRows: readonly { commitment: string; acceptedAt: string }[],
): { rootHash: string; payload: string; entryCount: number } {
  const commitments = commitmentsForUtcDay(day, allRows);
  const payload = tradeDisputeDayPayload(day, commitments);
  const rootHash = tradeDisputeDayRootHash(prevRoot, day, commitments);
  return { rootHash, payload, entryCount: commitments.length };
}
