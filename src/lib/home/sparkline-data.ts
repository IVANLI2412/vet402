import type { DailyMetricsRow } from "@/lib/observatory/metrics-rollup";

export type HomeSparklineDay = {
  day: string;
  attempts: number;
  settled: number;
};

/** Rolls up published daily metrics to one row per UTC day (all chains combined). */
export function homeSparklineDays(rows: DailyMetricsRow[]): HomeSparklineDay[] {
  const byDay = new Map<string, { attempts: number; settled: number }>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { attempts: 0, settled: 0 };
    d.attempts += r.l1Attempts;
    d.settled += r.l1Settled;
    byDay.set(r.day, d);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, v]) => ({ day, attempts: v.attempts, settled: v.settled }));
}