import type { SellerDetail } from "@/lib/sellers/board";
import { buildDeliveryCalendar } from "@/lib/sellers/delivery-calendar";

const PATTERNS: Record<string, string> = {
  delivered: "bg-brand-deep",
  failed:
    "bg-transparent bg-[linear-gradient(45deg,transparent_46%,currentColor_46%,currentColor_54%,transparent_54%),linear-gradient(-45deg,transparent_46%,currentColor_46%,currentColor_54%,transparent_54%)] bg-[length:6px_6px]",
  inconclusive: "border border-dashed border-brand-lift bg-transparent",
  empty: "border border-hair bg-transparent",
};

export default function SellerDeliveryCalendar({ detail }: { detail: SellerDetail }) {
  const allRows = detail.listings.flatMap((l) => {
    const rows = [];
    if (l.latest) rows.push({ facts: l.latest.facts, resourceKey: l.resourceKey });
    for (const e of l.earlier) rows.push({ facts: e.facts, resourceKey: l.resourceKey });
    return rows;
  });
  const cal = buildDeliveryCalendar(allRows, detail.fetchedAt);
  if (!cal || cal.rows.length === 0) return null;

  return (
    <section className="mx-auto mt-8 max-w-[70ch]" aria-labelledby="seller-delivery-calendar">
      <h2 id="seller-delivery-calendar" className="doc-subtitle">
        Delivery calendar (last 30 days)
      </h2>
      <p className="doc-note mt-2">
        One cell per listing per UTC day. Filled square: delivered. Cross hatch: settled without delivery. Dashed:
        inconclusive or not sorted. Empty: no purchase that day. Shape only; no colour scale.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="fact-table text-[0.75rem]">
          <caption className="sr-only">Purchases by listing and day</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">
                Listing
              </th>
              {cal.days.map((d) => (
                <th key={d} scope="col" className="num whitespace-nowrap px-1 font-normal text-brand-lift">
                  {d.slice(5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cal.rows.map((row) => (
              <tr key={row.endpointId}>
                <th scope="row" className="max-w-[14ch] truncate font-normal text-brand-deep" title={row.resourceKey}>
                  {row.resourceKey}
                </th>
                {row.cells.map((cell, i) => (
                  <td key={`${row.endpointId}-${cal.days[i]}`} className="p-1">
                    <span
                      className={`inline-block h-3 w-3 shrink-0 text-brand-deep ${PATTERNS[cell] ?? PATTERNS.empty}`}
                      aria-hidden
                    />
                    <span className="sr-only">
                      {cal.days[i]}: {cell}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}