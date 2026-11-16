import { NextResponse } from "next/server";
import { readKeylessCallerStats } from "@/lib/api/keyless-callers";

export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await readKeylessCallerStats();
  return NextResponse.json(stats, {
    headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}