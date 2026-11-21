import { calledVsDeliveredLines, type HostCalledVsDelivered } from "@/lib/sellers/called-vs-delivered";
import { getSellerCalledVsDeliveredCached } from "@/lib/sellers/cached";

export default async function SellerCalledVsDeliveredSection({ host }: { host: string }) {
  let data: HostCalledVsDelivered | null;
  try {
    data = await getSellerCalledVsDeliveredCached(host);
  } catch {
    return null;
  }
  // 列がまだ無い DB（SQL を当てる前）では節ごと隠す。
  if (!data) return null;
  const b = data.bazaar;
  const v = data.vet402;
  const lines = calledVsDeliveredLines(data);
  const hasBazaar =
    b.listingsWithFigures > 0 && b.calls30d !== null && b.observedNewestAt !== null;
  return (
    <section className="mx-auto mt-8 max-w-[70ch]">
      <h2 className="doc-subtitle">Called and delivered</h2>
      <p className="doc-note mt-2">
        vet402 purchase results are the primary figures. Bazaar call counts come from Coinbase&apos;s CDP Bazaar and are
        not checked by vet402.
      </p>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <div className="border-t border-brand-deep pt-3">
          <h3 className="doc-caption">Delivered rate, from purchases vet402 paid for and checked (all chains, last 30 days)</h3>
          {v.settled > 0 && v.deliveredPct !== null ? (
            <p className="mt-2 text-[2rem] font-semibold tabular-nums text-brand-deep">{v.deliveredPct}%</p>
          ) : null}
          {v.settled > 0 ? (
            <p className="mt-2 text-[1.25rem] tabular-nums text-brand-deep">
              {v.delivered.toLocaleString("en-US")} delivered of {v.settled.toLocaleString("en-US")} settled
            </p>
          ) : null}
          {lines.vet402.map((line) => (
            <p key={line} className="doc-note mt-2">
              {line}
            </p>
          ))}
        </div>
        <div className="border-t border-hair pt-3 sm:max-w-[26ch]">
          <h3 className="doc-caption text-brand-lift">Calls in the last 30 days, counted by the CDP Bazaar (Coinbase)</h3>
          {hasBazaar ? (
            <p className="mt-2 text-[0.9375rem] tabular-nums text-brand-lift">
              {b.calls30d!.toLocaleString("en-US")}
            </p>
          ) : null}
          {lines.bazaar.map((line) => (
            <p key={line} className="doc-note mt-2 text-[0.84375rem] text-brand-lift">
              {line}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}