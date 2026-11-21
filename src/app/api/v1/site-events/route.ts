import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";
import {
  homeCtaSource,
  homePasteErrorSource,
  homeVerdictSource,
  mcpPromptCopySource,
  navCheckClickSource,
} from "@/lib/site/event-sources";
import {
  homeResultStateSource,
  pathGroup,
  recordSiteEvent,
  shouldCount,
  sourceLabel,
} from "@/lib/site-events";

const MAX_BODY = 512;
const RL_LIMIT = 60;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`site-events:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!limited.allowed) {
    return new NextResponse(null, { status: 429, headers: { ...ipRateLimitHeaders(limited), "cache-control": "no-store" } });
  }

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
  } else if (event === "home_paste_invalid") {
    source = "invalid";
  } else if (event === "home_paste_error") {
    const kind = homePasteErrorSource(refRaw);
    if (!kind) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    source = kind;
  } else if (event === "home_verdict") {
    const verdict = homeVerdictSource(refRaw);
    if (!verdict) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    source = verdict;
  } else if (event === "home_cta") {
    const target = homeCtaSource(refRaw);
    if (!target) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    source = target;
  } else if (event === "nav_check_click") {
    const dest = navCheckClickSource(refRaw);
    if (!dest) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    source = dest;
  } else if (event === "mcp_docs_first_prompt_copy") {
    const id = mcpPromptCopySource(refRaw);
    if (!id) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    source = id;
  } else if (event === "mcp_html_redirect") {
    source = "direct";
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
const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
