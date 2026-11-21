import { NextRequest } from "next/server";
import { handleKeylessCheckRoute } from "@/lib/api/keyless-check-route";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Keyless alias of GET /api/v1/check (same body, same limits). */
export async function GET(request: NextRequest) {
  return handleKeylessCheckRoute(request, "rest:decision");
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
