import { NextRequest } from "next/server";
import { handleCheck } from "@/lib/api/check-handler";
import { isKeylessRequest, recordClientUsage, type ClientUsageRoute } from "@/lib/api/client-usage";
import { scheduleKeylessCallerRecord } from "@/lib/api/keyless-callers";
import { RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS } from "@/lib/api/keyless-limits";
import { rateLimitPolicyHeader } from "@/lib/api/ip-rate-limit";
import { publicRateLimit } from "@/lib/api/public-route";
import { mcpDeps } from "@/lib/mcp/deps";

const KEYLESS_POLICY = rateLimitPolicyHeader(RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);

function withPolicy(headers: Record<string, string>): Record<string, string> {
  return { ...headers, "RateLimit-Policy": KEYLESS_POLICY };
}

/** Shared keyless GET handler for /api/v1/check and /api/v1/decision. */
export async function handleKeylessCheckRoute(
  request: NextRequest,
  usageRoute: ClientUsageRoute,
): Promise<Response> {
  const gate = await publicRateLimit(request, "resolve", RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
  if (!gate.ok) {
    const h = new Headers(gate.response.headers);
    h.set("RateLimit-Policy", KEYLESS_POLICY);
    h.set("Cache-Control", "private, no-store");
    return new Response(gate.response.body, { status: gate.response.status, headers: h });
  }

  const keyless = isKeylessRequest(request.headers);

  const res = await handleCheck(request, mcpDeps());
  if (res.status === 200 && keyless) {
    recordClientUsage(request.headers, usageRoute);
    scheduleKeylessCallerRecord(request.headers);
  }

  const headers = new Headers(res.headers);
  const rateHeaders = withPolicy(gate.headers);
  for (const [k, v] of Object.entries(rateHeaders)) headers.set(k, v);
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers });
}
