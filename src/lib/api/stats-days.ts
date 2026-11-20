/** Stats GET routes: clamp `days` the same way whether or not the database is available. */
export function parseStatsDaysParam(raw: string | null, defaultDays: number): number {
  const parsed = raw === null ? defaultDays : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : defaultDays;
}