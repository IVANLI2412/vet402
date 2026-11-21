// 鍵なしの公開スコア頁（/payee/*・/agent/*）。/sellers と同じ proxy 入口で IP 枠を掛ける（2026-11-20 監査 R3）。
import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { isMalformedPayeePath } from "@/lib/payee/invalid-address-page";
import { rateLimitPageHtml } from "@/lib/sellers/page-limit";

export const PUBLIC_SCORE_RL_LIMIT = 10;
export const PUBLIC_SCORE_RL_WINDOW_MS = 60_000;

/** Next のリンク先読み・RSC 先読みを枠に数えない（adversary-4）。 */
export function isPublicScorePrefetch(request: Request): boolean {
  const h = request.headers;
  if (h.get("next-router-prefetch") === "1") return true;
  const purpose = (h.get("purpose") ?? h.get("sec-purpose") ?? "").toLowerCase();
  if (purpose.includes("prefetch")) return true;
  if (h.get("rsc") === "1" && h.get("next-router-prefetch") != null) return true;
  return false;
}

/** 採点頁の path か（API の /api/v1/payees は含まない）。 */
export function isPublicScorePagePath(pathname: string): boolean {
  if (isMalformedPayeePath(pathname)) return false;
  return (
    pathname === "/payee" ||
    pathname.startsWith("/payee/") ||
    pathname === "/agent" ||
    pathname.startsWith("/agent/")
  );
}

/** 通ってよければ null、上限なら 429（枠の判定不能なら 503）の HTML 頁。 */
export async function publicScoreRateLimitResponse(request: Request): Promise<NextResponse | null> {
  if (isPublicScorePrefetch(request)) return null;
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(
    `public-score-page:${ip}`,
    PUBLIC_SCORE_RL_LIMIT,
    PUBLIC_SCORE_RL_WINDOW_MS,
  );
  if (limited.allowed) return null;
  const wait = limited.retryAfter ?? 60;
  let path = "/";
  try {
    path = new URL(request.url).pathname;
  } catch {
    // 相対 URL など
  }
  const tooManyLead =
    "This network has opened payee or agent score pages more than " + PUBLIC_SCORE_RL_LIMIT + " times in the last minute.";
  return new NextResponse(
    rateLimitPageHtml({ waitSeconds: wait, unavailable: limited.unavailable, path, tooManyLead }),
    {
      status: limited.unavailable ? 503 : 429,
      headers: {
        ...ipRateLimitHeaders(limited),
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    },
  );
}