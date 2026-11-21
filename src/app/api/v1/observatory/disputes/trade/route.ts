import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { verifyP2PartyAccess, type P2PartyProof } from "@/lib/observatory/p2-party-verify";
import { submitTradeDisputeLeg } from "@/lib/observatory/trade-dispute-submit";
import { getTradeDisputeStore } from "@/lib/observatory/trade-dispute-store";
import { TRADE_ID_RE } from "@/lib/observatory/trade-dispute";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";

const RL_WINDOW_MS = 60_000;
const MAX_BODY_CHARS = 16_384;

function disputesUnavailable(perCaller: HeadersInit) {
  return NextResponse.json({ error: "disputes_unavailable" }, { status: 503, headers: perCaller });
}

function isDisputesUnavailable(error: unknown): boolean {
  return (error as { code?: string }).code === "disputes_unavailable";
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const rawText = await request.text();
  if (rawText.length > MAX_BODY_CHARS) {
    const limited = await consumeIpRateLimit(`disputes-trade:${ip}`, 20, RL_WINDOW_MS);
    const perCaller = ipRateLimitHeaders(limited);
    return NextResponse.json({ error: "payload_too_large" }, { status: 413, headers: perCaller });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    const limited = await consumeIpRateLimit(`disputes-trade:${ip}`, 20, RL_WINDOW_MS);
    const perCaller = ipRateLimitHeaders(limited);
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const limited = await consumeIpRateLimit(`disputes-trade:${ip}`, 20, RL_WINDOW_MS);
    const perCaller = ipRateLimitHeaders(limited);
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  const body = raw as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  const rateKey = action === "view" ? `disputes-trade-view:${ip}` : `disputes-trade:${ip}`;
  const rateMax = action === "view" ? 10 : 20;
  const limited = await consumeIpRateLimit(rateKey, rateMax, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const store = getTradeDisputeStore();
  if (!store) {
    return disputesUnavailable(perCaller);
  }

  if (action === "submit") {
    try {
      const result = await submitTradeDisputeLeg(body, store);
      if (!result.ok) {
        return NextResponse.json({ error: result.reason }, { status: result.status, headers: perCaller });
      }
      return NextResponse.json({ ok: true, commitment: result.commitment }, { status: 201, headers: perCaller });
    } catch (error) {
      if (isDisputesUnavailable(error)) return disputesUnavailable(perCaller);
      logServerErrorSafe("disputes-trade-submit", error);
      return disputesUnavailable(perCaller);
    }
  }

  if (action === "view") {
    const tradeId = typeof body.tradeId === "string" ? body.tradeId.trim().toLowerCase() : "";
    if (!TRADE_ID_RE.test(tradeId)) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
    }
    const party = body.party === "payer" || body.party === "seller" ? body.party : null;
    if (!party) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
    }
    const proofRaw = body.proof;
    if (typeof proofRaw !== "object" || proofRaw === null) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
    }
    const proofKind = (proofRaw as { kind?: unknown }).kind;
    if (typeof proofKind !== "string") {
      return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
    }
    const proof = proofRaw as P2PartyProof;
    try {
      const legs = await store.getLegs(tradeId);
      const payerRow = legs.payer.current ?? legs.payer.history[legs.payer.history.length - 1] ?? null;
      const sellerRow = legs.seller.current ?? legs.seller.history[legs.seller.history.length - 1] ?? null;
      const stored =
        payerRow || sellerRow
          ? {
              payer: (payerRow?.payer ?? sellerRow?.payer ?? "").toLowerCase(),
              receiver: (payerRow?.receiver ?? sellerRow?.receiver ?? "").toLowerCase(),
            }
          : null;
      const verification = await verifyP2PartyAccess(party, tradeId, proof, stored);
      if (!verification.ok) {
        if (verification.reason === "signature_expired") {
          return NextResponse.json({ error: verification.reason }, { status: 400, headers: perCaller });
        }
        if (verification.reason === "invalid_signature") {
          return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
        }
        return NextResponse.json({ error: "unverified" }, { status: 403, headers: perCaller });
      }
      const row = party === "payer" ? legs.payer.current : legs.seller.current;
      if (!row) {
        return NextResponse.json({ error: "unverified" }, { status: 403, headers: perCaller });
      }
      const view =
        party === "payer"
          ? {
              tradeId,
              side: "payer" as const,
              commitment: row.commitment,
              receivedBodySha256: row.receivedBodySha256 ?? undefined,
              paymentTx: row.paymentTx ?? undefined,
            }
          : {
              tradeId,
              side: "seller" as const,
              commitment: row.commitment,
              deliveredBodySha256: row.deliveredBodySha256 ?? undefined,
            };
      return NextResponse.json(view, { status: 200, headers: perCaller });
    } catch (error) {
      if (isDisputesUnavailable(error)) return disputesUnavailable(perCaller);
      logServerErrorSafe("disputes-trade-view", error);
      return disputesUnavailable(perCaller);
    }
  }

  return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
}
const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
