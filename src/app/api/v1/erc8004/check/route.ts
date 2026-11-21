import { logServerErrorSafe } from "@/lib/util/log-safe";
import { NextRequest, NextResponse } from "next/server";
import { rejectUnknownQuery } from "@/lib/api/export-guard";
import { publicRateLimit } from "@/lib/api/public-route";
import { ERROR_TEXT } from "@/lib/mcp/text";
import { ERC8004_CHECK_CACHE_SECONDS, erc8004CheckCacheMaxAgeSeconds, getErc8004CheckCached } from "@/lib/erc8004-check/cache";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "erc8004-check", RL_LIMIT, RL_WINDOW_MS);
  if (!gate.ok) return gate.response;

  const badQuery = rejectUnknownQuery(request.nextUrl.searchParams, ["chain", "agentId", "client", "feedbackIndex"], gate.headers);
  if (badQuery) return badQuery;

  const chain = request.nextUrl.searchParams.get("chain");
  const agentId = request.nextUrl.searchParams.get("agentId");
  const client = request.nextUrl.searchParams.get("client");
  const feedbackIndex = request.nextUrl.searchParams.get("feedbackIndex");

  let result: Awaited<ReturnType<typeof getErc8004CheckCached>>;
  try {
    result = await getErc8004CheckCached({ chain, agentId, client, feedbackIndex });
  } catch (error) {
    // 2026-11-18: 鎖の読み取り（RPC の回数制限など）の失敗は 500 ではなく、再試行できる 503 で返す。
    logServerErrorSafe("erc8004_check", error);
    return NextResponse.json(
      { error: "chain_unreadable" },
      { status: 503, headers: { ...gate.headers, "Cache-Control": "no-store", "Retry-After": "30" } },
    );
  }
  if ("error" in result) {
    const status =
      result.error === "feedback_not_found"
        ? 404
        : result.error === "invalid_chain" ||
            result.error === "invalid_agent_id" ||
            result.error === "invalid_client" ||
            result.error === "invalid_feedback_index" ||
            result.error === "missing_client_or_index" ||
            result.error === "ambiguous_feedback_index"
          ? 400
          : 400;
    const message = result.error in ERROR_TEXT ? ERROR_TEXT[result.error as keyof typeof ERROR_TEXT] : undefined;
    return NextResponse.json(
      message ? { error: result.error, message } : { error: result.error },
      {
        status,
        headers: {
          ...gate.headers,
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const sMaxAge = erc8004CheckCacheMaxAgeSeconds(result);

  return NextResponse.json(result, {
    status: 200,
    headers: {
      ...gate.cacheHeaders,
      "Cache-Control": `public, max-age=60, s-maxage=${sMaxAge}, stale-while-revalidate=300`,
    },
  });
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
