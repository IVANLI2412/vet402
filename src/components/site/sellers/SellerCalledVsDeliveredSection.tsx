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
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <div className="border-t border-brand-deep pt-3">
          <h3 className="doc-caption">Calls in the last 30 days, counted by the CDP Bazaar (Coinbase)</h3>
          {hasBazaar ? (
            <p className="mt-2 text-[1.75rem] tabular-nums text-brand-deep">
              {b.calls30d!.toLocaleString("en-US")}
            </p>
          ) : null}
          {lines.bazaar.map((line) => (
            <p key={line} className="doc-note mt-2">
              {line}
            </p>
          ))}
        </div>
        <div className="border-t border-brand-deep pt-3">
          <h3 className="doc-caption">
            Delivered rate, from purchases vet402 paid for and checked (all chains, last 30 days)
          </h3>
          {v.settled > 0 && v.deliveredPct !== null ? (
            <p className="mt-2 text-[1.75rem] tabular-nums text-brand-deep">{v.deliveredPct}%</p>
          ) : null}
          {lines.vet402.map((line) => (
            <p key={line} className="doc-note mt-2">
              {line}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}