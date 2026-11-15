import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders, sharedCacheRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { acquireExportSlot, exportBusyResponse, rejectUnknownQuery } from "@/lib/api/export-guard";
import { withNoindex } from "@/lib/api/public-read-robots";
import {
  buildDeliveryCsvBody,
  DELIVERY_CSV_BUYER,
  DELIVERY_CSV_COLUMN_NOTES,
  deliveryCsvAsOf,
  loadDeliveryExportRows,
  resolveObservatoryExportDays,
} from "@/lib/observatory/delivery-export";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/delivery.csv?days=90 — settled の行に delivery の 3 値を載せた CSV。
 * 既定の export.csv は凍結のまま。days・レート制限・export スロットは ledger export と同型。
 */

const RL_LIMIT = 6;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-delivery-export:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  const shared = withNoindex(sharedCacheRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const badQuery = rejectUnknownQuery(request.nextUrl.searchParams, ["days"], perCaller);
  if (badQuery) return badQuery;
  const daysParam = request.nextUrl.searchParams.get("days");
  const resolved = resolveObservatoryExportDays(daysParam);
  if (resolved.kind === "invalid_days") {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: perCaller });
  }
  if (resolved.kind === "redirect") {
    const canonical = new URL(request.nextUrl.toString());
    canonical.search = `?days=${resolved.days}`;
    return NextResponse.redirect(canonical, { status: 308, headers: perCaller });
  }
  const days = resolved.days;

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }

  const slot = await acquireExportSlot();
  if (!slot.ok) return exportBusyResponse(slot, perCaller);
  try {
    const { rows, truncated } = await loadDeliveryExportRows(db, days);
    const body = buildDeliveryCsvBody(rows);
    // 2026-11-16（x402#3226 の要望）: 誰の購入か・いつまでの行か・いつ作ったかをヘッダで運ぶ（CSV に注釈行は入れない）。
    const generatedAt = new Date().toISOString();
    return new NextResponse(body, {
      headers: {
        ...shared,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="vet402-delivery-${days}d.csv"`,
        "x-vet402-truncated": truncated ? "true" : "false",
        "x-vet402-license": "CC-BY-4.0",
        "x-vet402-retrieved-at": generatedAt,
        "x-vet402-generated-at": generatedAt,
        "x-vet402-as-of": deliveryCsvAsOf(rows),
        "x-vet402-buyer": DELIVERY_CSV_BUYER,
        "x-vet402-rows": String(rows.length),
        "x-vet402-window-days": String(days),
        "x-vet402-column-notes": DELIVERY_CSV_COLUMN_NOTES,
        Link:
          '<https://creativecommons.org/licenses/by/4.0/>; rel="license", ' +
          '<https://vet402.com/observatory/methodology#delivery-values>; rel="describedby"',
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
      },
    });
  } catch (error) {
    logServerErrorSafe("observatory_delivery_export", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  } finally {
    await slot.release();
  }
}