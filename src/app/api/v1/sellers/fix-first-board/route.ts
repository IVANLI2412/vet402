import { NextRequest, NextResponse } from "next/server";
import { getSellerBoardCached, SellersUnavailable } from "@/lib/sellers/cached";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";
import { publicRateLimit } from "@/lib/api/public-route";
import type { SellerBoard } from "@/lib/sellers/board";

export const dynamic = "force-dynamic";

/** /sellers/fix-first の client 描画用。全体の sellers 列は載せず groups・totals だけ返す。 */
export type FixFirstBoardPayload = Pick<SellerBoard, "fetchedAt" | "totals" | "groups">;

function slimBoard(board: SellerBoard): FixFirstBoardPayload {
  const { fetchedAt, totals, groups } = board;
  return { fetchedAt, totals, groups };
}

/** JSON board for /sellers/fix-first client render (smaller first HTML). */
export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "sellers-fix-first-board", 60);
  if (!gate.ok) return gate.response;

  try {
    const board = slimBoard(await getSellerBoardCached());
    return NextResponse.json(board, {
      headers: {
        ...gate.cacheHeaders,
        "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (e) {
    if (e instanceof SellersUnavailable) {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    throw e;
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);