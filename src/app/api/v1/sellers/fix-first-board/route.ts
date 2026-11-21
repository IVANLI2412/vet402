import { getSellerBoardCached, SellersUnavailable } from "@/lib/sellers/cached";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

/** JSON board for /sellers/fix-first client render (smaller first HTML). */
export async function GET() {
  try {
    const board = await getSellerBoardCached();
    return Response.json(board, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof SellersUnavailable) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    throw e;
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
