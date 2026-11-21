import { NextResponse } from "next/server";

/** API redirects keep Location and return a JSON body (unlike HTML page redirects). */
export function apiJsonRedirect(
  location: string | URL,
  status: 307 | 308,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const loc = typeof location === "string" ? location : location.toString();
  return NextResponse.json(
    { error: "moved", location: loc },
    {
      status,
      headers: { Location: loc, "Cache-Control": "no-store", ...extraHeaders },
    },
  );
}