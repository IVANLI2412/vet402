import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders, sharedCacheRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { withNoindex } from "@/lib/api/public-read-robots";
import { getDb } from "@/lib/db/client";
import {
  buildWeeklySummary,
  isoWeekUtcBounds,
  parseAgentIdParam,
  sha256HexUtf8,
} from "@/lib/observatory/erc8004-feedback";
import { readPurchasesForErc8004AgentWeek } from "@/lib/observatory/erc8004-purchase-match";
import { logServerErrorSafe } from "@/lib/util/log-safe";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ agentId: string }> }) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`erc8004-weekly:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  const shared = withNoindex(sharedCacheRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const week = request.nextUrl.searchParams.get("week");
  if (!week) {
    return NextResponse.json({ error: "week_required" }, { status: 400, headers: perCaller });
  }
  const bounds = isoWeekUtcBounds(week);
  if (!bounds) {
    return NextResponse.json({ error: "invalid_week" }, { status: 400, headers: perCaller });
  }

  const { agentId: agentParam } = await context.params;
  const parsed = parseAgentIdParam(agentParam);
  if (!parsed) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400, headers: perCaller });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }

  try {
    const rows = await readPurchasesForErc8004AgentWeek(db, parsed.agentId, parsed.chainId, bounds.start, bounds.end);
    const issuedAt = new Date().toISOString();
    const summary = buildWeeklySummary({
      agentCaip: parsed.caip,
      week,
      period: { from: bounds.start.toISOString(), to: bounds.end.toISOString() },
      rows,
      issuedAt,
    });
    const { contentSha256: _hash, ...body } = summary;
    const canonical = JSON.stringify(body);
    const hash = sha256HexUtf8(canonical);

    return new NextResponse(canonical, {
      status: 200,
      headers: {
        ...shared,
        "content-type": "application/json; charset=utf-8",
        "x-vet402-feedback-sha256": hash,
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
      },
    });
  } catch (error) {
    logServerErrorSafe("erc8004_weekly", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}