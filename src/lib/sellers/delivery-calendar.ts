import type { SellerRowFacts } from "./fix-modes";
import { classifySellerRow, type Bucket } from "./fix-modes";

export type DeliveryCalendarCell = "empty" | "delivered" | "failed" | "inconclusive";

export type DeliveryCalendarRow = {
  endpointId: string;
  resourceKey: string;
  cells: DeliveryCalendarCell[];
};

export type DeliveryCalendar = {
  days: string[];
  rows: DeliveryCalendarRow[];
};

function cellOf(bucket: Bucket): DeliveryCalendarCell {
  if (bucket === "delivered") return "delivered";
  if (bucket === "pending") return "empty";
  if (bucket === "vet402" || bucket === "seller" || bucket === "unsorted") return "failed";
  return "inconclusive";
}

function utcDay(iso: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? null;
}

export type DeliveryCalendarInputRow = { facts: SellerRowFacts; resourceKey: string };

/** Last N UTC days ending at read time, one cell per listing per day (most recent purchase on that day). */
export function buildDeliveryCalendar(
  rows: readonly DeliveryCalendarInputRow[],
  fetchedAt: string,
  windowDays = 30,
): DeliveryCalendar | null {
  const end = Date.parse(fetchedAt);
  if (!Number.isFinite(end)) return null;
  const dayMs = 86_400_000;
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(end - i * dayMs);
    days.push(d.toISOString().slice(0, 10));
  }
  const daySet = new Set(days);
  const byEndpoint = new Map<string, DeliveryCalendarInputRow[]>();
  for (const row of rows) {
    const day = utcDay(row.facts.attemptedAt);
    if (!day || !daySet.has(day)) continue;
    const list = byEndpoint.get(row.facts.endpointId) ?? [];
    list.push(row);
    byEndpoint.set(row.facts.endpointId, list);
  }
  if (byEndpoint.size === 0) return null;

  const calendarRows: DeliveryCalendarRow[] = [];
  for (const [endpointId, list] of byEndpoint) {
    const byDay = new Map<string, DeliveryCalendarInputRow>();
    for (const row of list) {
      const day = utcDay(row.facts.attemptedAt)!;
      const prev = byDay.get(day);
      if (!prev || row.facts.attemptedAt > prev.facts.attemptedAt) byDay.set(day, row);
    }
    const cells = days.map((day) => {
      const row = byDay.get(day);
      if (!row) return "empty" as const;
      return cellOf(classifySellerRow(row.facts, { now: end }).bucket);
    });
    const resourceKey = list[0]?.resourceKey ?? endpointId;
    calendarRows.push({ endpointId, resourceKey, cells });
  }
  calendarRows.sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
  return { days, rows: calendarRows.slice(0, 8) };
}