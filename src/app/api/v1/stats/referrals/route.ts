import { NextRequest, NextResponse } from "next/server";
import { readReferralPageViews } from "@/lib/site-referral-stats";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("days");
  const parsed = raw === null ? 7 : Number.parseInt(raw, 10);
  const days = Number.isFinite(parsed) ? parsed : 7;
  const stats = await readReferralPageViews(days);
  return NextResponse.json(stats, {
    headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}