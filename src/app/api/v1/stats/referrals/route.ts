import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { parseStatsDaysParam } from "@/lib/api/stats-days";
import { statsDbUnavailableResponse } from "@/lib/api/stats-unavailable";
import { readReferralPageViews } from "@/lib/site-referral-stats";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "stats-referrals", RL_LIMIT, RL_WINDOW_MS);
  if (!gate.ok) return gate.response;
  const unavailable = statsDbUnavailableResponse(gate.headers);
  if (unavailable) return unavailable;

  const days = parseStatsDaysParam(request.nextUrl.searchParams.get("days"), 7);
  const stats = await readReferralPageViews(days);
  return NextResponse.json(stats, {
    headers: { ...gate.headers, ...gate.cacheHeaders, "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}