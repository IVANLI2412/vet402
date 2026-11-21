import { NextResponse } from "next/server";

export const API_DOCS_URL = "https://vet402.com/docs/api" as const;

const STANDARD_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof STANDARD_METHODS)[number];

/** 405 envelope shared by every REST route under /api (MCP JSON-RPC is separate). */
export function apiMethodNotAllowed(
  allowed: readonly string[],
  extraHeaders?: Record<string, string>,
): NextResponse {
  const normalized = [...new Set(allowed.map((m) => m.toUpperCase()))];
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
      handlers[method] = () => apiMethodNotAllowed(allowed);
    }
  }
  return handlers;
}