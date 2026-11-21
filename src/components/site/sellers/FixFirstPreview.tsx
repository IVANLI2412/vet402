import Link from "next/link";
import { boardAsOfDay, type SellerBoard, type FixGroup } from "@/lib/sellers/board";
import { AttributionReviewNote, fixFirstHeading, sellerPath } from "@/components/site/sellers/SellersViews";

const PREVIEW_LINES_PER_SECTION = 6;

function previewSellers(groups: readonly FixGroup[], max: number) {
  const out: { host: string; listings: number; group: string; side: FixGroup["side"] }[] = [];
  for (const g of groups) {
    for (const s of g.sellers) {
      out.push({ host: s.host, listings: s.listings, group: g.title, side: g.side });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** JS 前の骨組み: 読み込み後と同じ側の見出しと帰属の注記（/sellers/fix-first・persona G3-001）。 */
export function FixFirstPreview({ board }: { board: SellerBoard }) {
  const sellerGroups = board.groups.filter((g) => g.side === "seller");
  const vet402Groups = board.groups.filter((g) => g.side === "vet402");
  const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
  const paid = failed + board.totals.delivered + board.totals.pending;
  const sellerLines = previewSellers(sellerGroups, PREVIEW_LINES_PER_SECTION);
  const vet402Lines = previewSellers(vet402Groups, PREVIEW_LINES_PER_SECTION);
  return (
    <article id="fix-first-ssr" className="sheet sheet-wide" aria-busy="true">
      <h1 className="doc-title mt-8">{fixFirstHeading(boardAsOfDay(board))}</h1>
      <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
      <p className="doc-p">
        The Base listings whose latest purchase did not deliver, grouped by what went wrong. vet402 reads the ledger on
        this page; the full board loads next.
      </p>
      <h2 className="sec-head mt-8">
        <span className="sec-no">1.</span>
        <span>On the seller&apos;s side</span>
      </h2>
      <AttributionReviewNote />
      {sellerLines.length === 0 ? (
        <p className="doc-p text-brand-lift">None.</p>
      ) : (
        <ol className="list-decimal pl-6 text-[0.84375rem] text-brand">
          {sellerLines.map((row) => (
            <li key={`seller-${row.host}-${row.group}`} className="mt-1">
              <Link href={sellerPath(row.host)} className="underline">
                {row.host}
              </Link>
              <span className="text-brand-lift">
                {" "}
                · {row.listings} {row.listings === 1 ? "listing" : "listings"} · {row.group}
              </span>
            </li>
          ))}
        </ol>
      )}
      <h2 className="sec-head mt-8">
        <span className="sec-no">2.</span>
        <span>On vet402&apos;s side: nothing for sellers to fix</span>
      </h2>
      {vet402Lines.length === 0 ? (
        <p className="doc-p text-brand-lift">None.</p>
      ) : (
        <ol className="list-decimal pl-6 text-[0.84375rem] text-brand">
          {vet402Lines.map((row) => (
            <li key={`vet402-${row.host}-${row.group}`} className="mt-1">
              <Link href={sellerPath(row.host)} className="underline">
                {row.host}
              </Link>
              <span className="text-brand-lift">
                {" "}
                · {row.listings} {row.listings === 1 ? "listing" : "listings"} · {row.group}
              </span>
            </li>
          ))}
        </ol>
      )}
      {failed > 0 && paid > 0 ? (
        <p className="doc-p mt-4 text-xs text-brand-lift">
          {failed} of {paid} paid listings did not deliver in the latest attempt (full counts load with the board).
        </p>
      ) : null}
    </article>
  );
}