import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import { boardAsOfDay } from "@/lib/sellers/board";
import { getSellerBoardCached } from "@/lib/sellers/cached";
import { FixFirstBoardClient } from "@/components/site/sellers/FixFirstBoardClient";
import TrackView from "@/components/site/TrackView";

/**
 * /sellers/fix-first — the Base listings whose latest purchase did not deliver, grouped by kind of
 * failure (src/lib/sellers/fix-modes.ts), with one fix per group and whose side it is on.
 */

export const dynamic = "force-dynamic";

// 2026-09-29 第2巡: 表題に「いつの結果か」の日付（最新の試行の UTC の日付・一覧のキャッシュから）。
export async function generateMetadata(): Promise<Metadata> {
  const day = await getSellerBoardCached()
    .then((b) => boardAsOfDay(b))
    .catch(() => null);
  return pageMetadata({
    title: day ? `What to fix first (x402 on Base), as of ${day}` : "What to fix first (x402 on Base)",
    description:
      "The x402 listings on Base whose latest purchase by vet402 did not deliver, grouped by what went wrong, with whether it is the seller's side, vet402's, or not sorted.",
    path: "/sellers/fix-first",
    // 2026-09-29 敵対的監査: 帰属の見直しが済むまで noindex。
    noindex: true,
  });
}

export default function FixFirstPage() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <TrackView event="fix_first_open" />
      <FixFirstBoardClient />
    </main>
  );
}
