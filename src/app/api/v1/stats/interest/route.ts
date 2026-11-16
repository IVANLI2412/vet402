import { NextRequest, NextResponse } from "next/server";
import { readWatchSellersInterest } from "@/lib/site-interest-stats";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("days");
  const parsed = raw === null ? 14 : Number.parseInt(raw, 10);
  const days = Number.isFinite(parsed) ? parsed : 14;
  const stats = await readWatchSellersInterest(days);
  return NextResponse.json(stats, {
    headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}