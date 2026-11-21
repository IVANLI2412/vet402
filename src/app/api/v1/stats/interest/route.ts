import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { parseStatsDaysParam } from "@/lib/api/stats-days";
import { statsDbUnavailableResponse } from "@/lib/api/stats-unavailable";
import { readWatchSellersInterest } from "@/lib/site-interest-stats";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "stats-interest", RL_LIMIT, RL_WINDOW_MS);
  if (!gate.ok) return gate.response;
  const unavailable = statsDbUnavailableResponse(gate.headers);
  if (unavailable) return unavailable;

  const days = parseStatsDaysParam(request.nextUrl.searchParams.get("days"), 14);
  const stats = await readWatchSellersInterest(days);
  return NextResponse.json(stats, {
    headers: { ...gate.headers, ...gate.cacheHeaders, "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
