import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { submitDispute } from "@/lib/observatory/disputes";
import { TRADE_ID_RE } from "@/lib/observatory/trade-dispute";
import { getTradeDisputeStore, publicJsonForTrade } from "@/lib/observatory/trade-dispute-store";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const dynamic = "force-dynamic";

const RL_LIMIT = 5;
const RL_WINDOW_MS = 60_000;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`disputes-read:${ip}`, 60, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  if (request.nextUrl.searchParams.has("purchaseId")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
  }

  const tradeId = request.nextUrl.searchParams.get("tradeId")?.trim().toLowerCase() ?? "";
  if (!TRADE_ID_RE.test(tradeId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
  }

  const store = getTradeDisputeStore();
  if (!store) {
    return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
  }

  try {
    const body = await publicJsonForTrade(store, tradeId);
    if (!body) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: perCaller });
    }
    return NextResponse.json(body, { status: 200, headers: perCaller });
  } catch (error) {
    if ((error as { code?: string }).code === "disputes_unavailable" || isMissingSchemaError(error)) {
      return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
    }
    logServerErrorSafe("disputes-get", error);
    return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
  }
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`disputes:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  try {
    const result = await submitDispute({
      endpointId: typeof body.endpointId === "string" ? body.endpointId : "",
      subject: typeof body.subject === "string" ? body.subject : "",
      reason: typeof body.reason === "string" ? body.reason : "",
      issued: typeof body.issued === "string" ? body.issued : "",
      address: typeof body.address === "string" ? body.address : "",
      signature: typeof body.signature === "string" ? body.signature : "",
    });
    if (!result.ok) {
      const status =
        result.reason === "endpoint_not_found"
          ? 404
          : result.reason === "not_payto_signer"
            ? 403
            : result.reason === "db_unavailable"
              ? 503
              : result.reason === "replayed"
                ? 409
                : 400;
      return NextResponse.json({ error: result.reason }, { status, headers: perCaller });
    }
    return NextResponse.json(
      {
        ok: true,
        id: result.id,
        remeasureVerdict: result.remeasureVerdict,
        note: "Re-measured through the normal publication gate. Records are never deleted on dispute — corrections publish with the same weight.",
      },
      { status: 201, headers: perCaller },
    );
  } catch (error) {
    logServerErrorSafe("disputes", error);
    return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
  }
}
