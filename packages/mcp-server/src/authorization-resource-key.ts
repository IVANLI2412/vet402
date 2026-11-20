/** resource_id (lowercase hex 64) from /resolve when available. */
const RESOURCE_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize a resource URL so spelling variants share one live-authorization slot.
 * Lowercases host, strips a trailing dot on the host, drops default :443, and drops a lone trailing `?`.
 */
export function normalizeResourceUrlForAuth(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const port =
    parsed.port === "443" || (parsed.protocol === "https:" && parsed.port === "")
      ? ""
      : parsed.port
        ? `:${parsed.port}`
        : "";
  let pathname = parsed.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  let search = parsed.search;
  if (search === "?") search = "";
  return `${parsed.protocol}//${host}${port}${pathname}${search}`;
}

/**
 * Key for in-process duplicate-sign guard: prefer resolved resource_id, else normalized URL, plus payTo when known.
 */
export function authorizationResourceKey(input: {
  resourceUrl?: string;
  resourceId?: string | null;
  payTo?: string | null;
}): string | null {
  const payTo =
    typeof input.payTo === "string" && input.payTo.length > 0 ? input.payTo.toLowerCase() : "";
  const id = typeof input.resourceId === "string" && RESOURCE_ID_RE.test(input.resourceId) ? input.resourceId : null;
  if (id !== null) return payTo ? `${id}\n${payTo}` : id;
  if (typeof input.resourceUrl === "string" && input.resourceUrl.length > 0) {
    const norm = normalizeResourceUrlForAuth(input.resourceUrl);
    return payTo ? `${norm}\n${payTo}` : norm;
  }
  return null;
}