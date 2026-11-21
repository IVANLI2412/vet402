import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import {
  tradeDisputeDayPayload,
  tradeDisputeDayRootHash,
  commitmentsForUtcDay,
} from "@/lib/observatory/e6-anchors";
import { getTradeDisputeStore } from "@/lib/observatory/trade-dispute-store";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function disputesUnavailable(perCaller: HeadersInit) {
  return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
}

function isDisputesUnavailable(error: unknown): boolean {
  return (error as { code?: string }).code === "disputes_unavailable";
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`disputes-day:${ip}`, 30, 60_000);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const day = request.nextUrl.searchParams.get("day")?.trim() ?? "";
  if (!DAY_RE.test(day)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
  }

  const store = getTradeDisputeStore();
  if (!store) {
    return disputesUnavailable(perCaller);
  }

  try {
    const sealed = await store.getDaySeal(day);
    const prevRoot = sealed?.prevRoot ?? (await store.latestRootBefore(day));
    const dayRows = await store.listLegsForUtcDay(day);
    const commitments = commitmentsForUtcDay(
      day,
      dayRows.map((r) => ({ commitment: r.commitment, acceptedAt: r.acceptedAt })),
    );
    const livePayload = tradeDisputeDayPayload(day, commitments);
    const liveRootHash = tradeDisputeDayRootHash(prevRoot, day, commitments);
    const payload = sealed?.payload ?? livePayload;
    const conflict =
      sealed !== null && (sealed.payload !== livePayload || sealed.rootHash !== liveRootHash);
    return NextResponse.json(
      {
        day,
        payload,
        rootHash: sealed?.rootHash ?? liveRootHash,
        prevRoot: prevRoot ?? "genesis",
        sealed: Boolean(sealed),
        ...(conflict ? { conflict: true as const } : {}),
      },
      { status: 200, headers: perCaller },
    );
  } catch (error) {
    if (isDisputesUnavailable(error)) return disputesUnavailable(perCaller);
    logServerErrorSafe("disputes-day", error);
    return disputesUnavailable(perCaller);
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
