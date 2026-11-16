import { NextRequest } from "next/server";
import { handleKeylessCheckRoute } from "@/lib/api/keyless-check-route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Keyless alias of GET /api/v1/check (same body, same limits). */
export async function GET(request: NextRequest) {
  return handleKeylessCheckRoute(request, "rest:decision");
}