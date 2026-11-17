import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { ERC8004_CHECK_CACHE_SECONDS, getErc8004CheckCached } from "@/lib/erc8004-check/cache";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "erc8004-check", RL_LIMIT, RL_WINDOW_MS);
  if (!gate.ok) return gate.response;

  const chain = request.nextUrl.searchParams.get("chain");
  const agentId = request.nextUrl.searchParams.get("agentId");
  const client = request.nextUrl.searchParams.get("client");
  const feedbackIndex = request.nextUrl.searchParams.get("feedbackIndex");

  const result = await getErc8004CheckCached({ chain, agentId, client, feedbackIndex });
  if ("error" in result) {
    const status =
      result.error === "feedback_not_found"
        ? 404
        : result.error === "invalid_chain" ||
            result.error === "invalid_agent_id" ||
            result.error === "invalid_client" ||
            result.error === "invalid_feedback_index" ||
            result.error === "missing_client_or_index"
          ? 400
          : 400;
    return NextResponse.json(
      { error: result.error },
      {
        status,
        headers: {
          ...gate.headers,
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return NextResponse.json(result, {
    status: 200,
    headers: {
      ...gate.headers,
      ...gate.cacheHeaders,
      "Cache-Control": `public, max-age=60, s-maxage=${ERC8004_CHECK_CACHE_SECONDS}, stale-while-revalidate=300`,
    },
  });
}