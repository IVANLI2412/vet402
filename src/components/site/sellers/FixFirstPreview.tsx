import Link from "next/link";
import { boardAsOfDay, type SellerBoard } from "@/lib/sellers/board";
import { fixFirstHeading, sellerPath } from "@/components/site/sellers/SellersViews";

const PREVIEW_LINES = 10;

function previewHosts(board: SellerBoard, max: number) {
  const out: { host: string; listings: number; group: string }[] = [];
  for (const g of board.groups) {
    for (const s of g.sellers) {
      out.push({ host: s.host, listings: s.listings, group: g.title });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** JS 前の骨組み: 見出し・説明・台帳の先頭行（/sellers/fix-first・FIX_UX5）。 */
export function FixFirstPreview({ board }: { board: SellerBoard }) {
  const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
  const paid = failed + board.totals.delivered + board.totals.pending;
  const lines = previewHosts(board, PREVIEW_LINES);
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
        <span>On the seller&apos;s side — first sellers in the ledger</span>
      </h2>
      <ol className="list-decimal pl-6 text-[0.84375rem] text-brand">
        {lines.map((row) => (
          <li key={row.host} className="mt-1">
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
      {failed > 0 && paid > 0 ? (
        <p className="doc-p mt-4 text-xs text-brand-lift">
          {failed} of {paid} paid listings did not deliver in the latest attempt (full counts load with the board).
        </p>
      ) : null}
    </article>
  );
}