import { getDailyMetricsHistory } from "@/lib/observatory/metrics-rollup";
import { homeSparklineDays } from "@/lib/home/sparkline-data";

function SparklineSvg({
  days,
  readLabel,
}: {
  days: { day: string; attempts: number; settled: number }[];
  readLabel: string;
}) {
  if (days.length < 2) return null;
  const W = 640;
  const H = 96;
  const PAD = { top: 6, right: 6, bottom: 18, left: 36 };
  const max = Math.max(1, ...days.map((d) => Math.max(d.attempts, d.settled)));
  const x = (i: number) =>
    PAD.left + (days.length === 1 ? 0 : (i * (W - PAD.left - PAD.right)) / (days.length - 1));
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const path = (pick: (d: (typeof days)[0]) => number) =>
    days.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");
  const first = days[0]!.day;
  const last = days[days.length - 1]!.day;

  return (
    <figure className={undefined}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Daily paid attempts and settled purchases, ${first} to ${last}, read ${readLabel}.`}
        className="h-auto w-full max-w-[40rem] text-[var(--lp-ink-3)]"
      >
        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} stroke="currentColor" strokeWidth="1" opacity="0.4" />
        <path d={path((d) => d.attempts)} fill="none" stroke="currentColor" strokeWidth="1.25" opacity="0.55" />
        <path d={path((d) => d.settled)} fill="none" stroke="currentColor" strokeWidth="1.5" />
        <text x={PAD.left} y={H - 4} fontSize="10" fill="currentColor">
          {first}
        </text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" fontSize="10" fill="currentColor">
          {last}
        </text>
      </svg>
      <figcaption className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--lp-ink-3)]">
        <span className="font-semibold text-[var(--lp-ink-2)]">Figure.</span> Paid attempts (lighter line) and settled
        purchases (solid line), daily, all chains, from the public history rollup. Read {readLabel}. The last day may be
        partial.
      </figcaption>
    </figure>
  );
}

export default async function HomePurchaseSparkline({
  historyDays,
  readDate,
  readTime,
}: {
  historyDays: number;
  readDate: string;
  readTime: string;
}) {
  let rows;
  try {
    rows = await getDailyMetricsHistory(historyDays);
  } catch {
    return null;
  }
  const days = homeSparklineDays(rows);
  if (days.length < 2) return null;
  return <SparklineSvg days={days} readLabel={`${readDate} ${readTime} UTC`} />;
}