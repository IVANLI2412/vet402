import { NextRequest } from "next/server";
import { handleFind } from "@/lib/find/find-handler";
import { readFindAlternatives } from "@/lib/find/reads";
import { FIND_MIN_DELIVERED_RATE, FIND_WINDOW_DAYS } from "@/lib/find/rank";
import { RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS } from "@/lib/api/keyless-limits";
import { publicRateLimit } from "@/lib/api/public-route";
import { getDb } from "@/lib/db/client";
import { withNoindex } from "@/lib/api/public-read-robots";
import { NextResponse } from "next/server";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FIND_MIN_DELIVERED_PCT = Math.round(FIND_MIN_DELIVERED_RATE * 100);

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "find", RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
  if (!gate.ok) {
    const headers = new Headers(gate.response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(gate.response.body, { status: gate.response.status, headers });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: withNoindex({ "Cache-Control": "no-store" }) },
    );
  }
  const res = await handleFind(request, {
    findAlternatives: (like, limit) =>
      readFindAlternatives(db, like, {
        limit,
        minDeliveredPct: FIND_MIN_DELIVERED_PCT,
        windowDays: FIND_WINDOW_DAYS,
      }),
  });
  const headers = new Headers(res.headers);
  const rateHeaders = res.status === 200 ? gate.cacheHeaders : gate.headers;
  for (const [k, v] of Object.entries(rateHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
