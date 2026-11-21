import { NextRequest, NextResponse } from "next/server";

export const API_DOCS_URL = "https://vet402.com/docs/api" as const;

/** GET だけを持つルートの HEAD: 本文なしで GET と同じステータスとヘッダーを返す。 */
/** GET の第2引数（route context）までそのまま渡す。Next のルート型と揃えるため緩い型にする。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Next route GET arity varies by segment params
export function headFromGet(get: (request: NextRequest, ...args: any[]) => Promise<Response | NextResponse> | Response | NextResponse): (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
) => Promise<NextResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (request: NextRequest, ...args: any[]) => {
    const res = await get(request, ...args);
    return new NextResponse(null, { status: res.status, headers: res.headers });
  };
}

const STANDARD_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof STANDARD_METHODS)[number];

function normalizedAllowed(allowed: readonly string[]): string[] {
  const normalized = [...new Set(allowed.map((m) => m.toUpperCase()))];
  if (normalized.includes("GET")) normalized.push("HEAD");
  return [...new Set(normalized)];
}

/** 405 envelope shared by every REST route under /api (MCP JSON-RPC is separate). */
export function apiMethodNotAllowed(
  allowed: readonly string[],
  extraHeaders?: Record<string, string>,
): NextResponse {
  const normalized = normalizedAllowed(allowed);
  return NextResponse.json(
    { error: "method_not_allowed", allowed: normalized, documentation: API_DOCS_URL },
    {
      status: 405,
      headers: {
        "Cache-Control": "no-store",
        Allow: normalized.join(", "),
        ...extraHeaders,
      },
    },
  );
}

/** Route modules: export one handler per HTTP verb this path does not implement. */
export function exportDisallowedMethodHandlers(
  allowed: readonly string[],
): Partial<Record<HttpMethod, () => NextResponse>> {
  const allowedSet = new Set(allowed.map((m) => m.toUpperCase()));
  const handlers: Partial<Record<HttpMethod, () => NextResponse>> = {};
  for (const method of STANDARD_METHODS) {
    if (!allowedSet.has(method)) {
      // GET を実装しているルートは HEAD を 405 にしない（監査 C-6 / whitehat-5）。
      if (method === "HEAD" && allowedSet.has("GET")) continue;
      handlers[method] = () => apiMethodNotAllowed(allowed);
    }
  }
  return handlers;
}