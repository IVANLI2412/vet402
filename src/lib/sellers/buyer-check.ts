import { SITE_URL } from "@/lib/site-url";

/** URL for the keyless check call on one listing (GET /api/v1/check). Only https listings, the API refuses http. */
export function buyerCheckUrl(resourceUrl: string, method: string | null): string | null {
  if (!resourceUrl.startsWith("https://")) return null;
  const q = new URLSearchParams({ url: resourceUrl });
  if (method && /^[A-Za-z]{1,10}$/.test(method)) q.set("method", method.toUpperCase());
  return `${SITE_URL}/api/v1/check?${q.toString()}`;
}

/** First listing that yields a check URL, in page order. */
export function firstBuyerCheckUrl(listings: { resourceUrl: string; method: string | null }[]): string | null {
  for (const l of listings) {
    const u = buyerCheckUrl(l.resourceUrl, l.method);
    if (u) return u;
  }
  return null;
}
