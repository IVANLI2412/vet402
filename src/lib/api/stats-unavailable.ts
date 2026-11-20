import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";

export function statsDbUnavailableResponse(headers: Record<string, string> = {}): NextResponse | null {
  if (getDb()) return null;
  return NextResponse.json(
    { error: "temporarily_unavailable" },
    { status: 503, headers: { "cache-control": "no-store", ...headers } },
  );
}