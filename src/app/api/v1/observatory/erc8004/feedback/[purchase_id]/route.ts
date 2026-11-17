import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders, sharedCacheRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { withNoindex } from "@/lib/api/public-read-robots";
import { getDb } from "@/lib/db/client";
import {
  buildErc8004FeedbackDocument,
  serializeFeedbackBody,
  sha256HexUtf8,
} from "@/lib/observatory/erc8004-feedback";
import { readPurchaseForErc8004Feedback } from "@/lib/observatory/erc8004-purchase-match";
import { logServerErrorSafe } from "@/lib/util/log-safe";

const RL_LIMIT = 60;
const RL_WINDOW_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ purchase_id: string }> }) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`erc8004-feedback:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  const shared = withNoindex(sharedCacheRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const { purchase_id: purchaseId } = await context.params;
  if (!UUID_RE.test(purchaseId)) {
    return NextResponse.json({ error: "invalid_purchase_id" }, { status: 400, headers: perCaller });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }

  try {
    const row = await readPurchaseForErc8004Feedback(db, purchaseId);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: perCaller });
    }
    const issuedAt = new Date().toISOString();
    const doc = buildErc8004FeedbackDocument(row, issuedAt);
    if (!doc) {
      return NextResponse.json({ error: "no_erc8004_match" }, { status: 404, headers: perCaller });
    }

    const { contentSha256, ...body } = doc;
    const canonical = serializeFeedbackBody(body);
    const hash = sha256HexUtf8(canonical);
    if (hash !== contentSha256) {
      logServerErrorSafe("erc8004_feedback_hash", new Error("contentSha256 mismatch after build"));
    }

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
    logServerErrorSafe("erc8004_feedback", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}