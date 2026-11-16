import { NextRequest, NextResponse } from "next/server";
import { readBadgeFetches } from "@/lib/badge/fetch-stats";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("days");
  const parsed = raw === null ? 7 : Number.parseInt(raw, 10);
  const days = Number.isFinite(parsed) ? parsed : 7;
  const stats = await readBadgeFetches(days);
  return NextResponse.json(stats, {
    headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}