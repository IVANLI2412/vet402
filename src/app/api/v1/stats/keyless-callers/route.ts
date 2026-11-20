import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { statsDbUnavailableResponse } from "@/lib/api/stats-unavailable";
import { readKeylessCallerStats } from "@/lib/api/keyless-callers";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "stats-keyless-callers", RL_LIMIT, RL_WINDOW_MS);
  if (!gate.ok) return gate.response;
  const unavailable = statsDbUnavailableResponse(gate.headers);
  if (unavailable) return unavailable;

  const stats = await readKeylessCallerStats();
  return NextResponse.json(stats, {
    headers: { ...gate.headers, ...gate.cacheHeaders, "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}