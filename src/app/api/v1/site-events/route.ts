import { NextRequest, NextResponse } from "next/server";
import {
  homeResultStateSource,
  pathGroup,
  recordSiteEvent,
  shouldCount,
  sourceLabel,
} from "@/lib/site-events";

const MAX_BODY = 512;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!shouldCount(request.headers)) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  let body: { e?: unknown; p?: unknown; r?: unknown };
  try {
    body = JSON.parse(raw) as { e?: unknown; p?: unknown; r?: unknown };
  } catch {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const event = typeof body.e === "string" ? body.e.trim() : "";
  const pathRaw = typeof body.p === "string" ? body.p : "";
  if (!event || !pathRaw) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const refRaw = typeof body.r === "string" ? body.r.trim().slice(0, 253) : "";

  let source: string;
  if (event === "home_result_state") {
    const state = homeResultStateSource(refRaw);
    if (!state) {
      return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    source = state;
  } else if (event === "watch_sellers_interest" && refRaw === "seller_page") {
    source = "seller_page";
  } else {
    let refHost: string | undefined;
    if (refRaw && /^[a-z0-9.-]+$/i.test(refRaw)) refHost = refRaw;
    source = sourceLabel(refHost);
  }

  recordSiteEvent({
    event,
    path: pathGroup(pathRaw),
    source,
  });

  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
