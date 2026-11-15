const STOP = new Set([
  "api",
  "apis",
  "rest",
  "public",
  "endpoint",
  "endpoints",
  "json",
  "query",
  "get",
  "post",
  "put",
  "data",
  "service",
  "services",
  "tool",
  "tools",
  "www",
  "http",
  "https",
  "index",
  "html",
  "php",
  "call",
  "run",
  "free",
  "premium",
  "prod",
  "beta",
  "test",
  "demo",
  "the",
  "and",
  "for",
  "with",
  "paid",
  "pay",
  "x402",
  "mcp",
  "v",
]);

const WORD = /^[a-z]{3,30}$/;

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function tokensFromPiece(piece: string): string[] {
  const lower = decodeSegment(piece).toLowerCase();
  return lower.split(/[-_.]+/).filter((t) => WORD.test(t) && !STOP.has(t));
}

function tokensFromPath(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    for (const t of tokensFromPiece(parts[i]!)) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

function tokensFromHost(hostname: string): string[] {
  const labels = hostname.toLowerCase().split(".");
  if (labels.length < 3) return [];
  const body = labels.slice(0, -2);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of body) {
    for (const t of tokensFromPiece(label)) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

/** Up to two use terms from an https URL path (then host labels). */
export function termsOfUrl(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "https:") return [];

  const fromPath = tokensFromPath(parsed.pathname);
  if (fromPath.length > 0) return fromPath.slice(0, 2);

  const fromHost = tokensFromHost(parsed.hostname);
  return fromHost.slice(0, 2);
}