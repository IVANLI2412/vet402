// ============================================================
// 評判ページ /x402/sellers/{host} の sitemap（2026-11-16 pmf85 PAGES）。
// 届いた記録だけを索引する 50 ホスト（getReputationHostsCached）。
// 一覧の lastmod は getSellerBoardCached の各売り手の最新購入時刻（従来と同じデータ源）。
// ============================================================
import { getSellerBoardCached } from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { getReputationHostsCached, REPUTATION_HOST_LIMIT } from "@/lib/sellers/reputation";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function reputationLoc(host: string): string {
  return `${SITE_URL}/x402/sellers/${encodeURIComponent(host)}`;
}

export async function GET() {
  let hosts: string[];
  const sellersByHost = new Map<string, { lastAttemptAt: string | null }>();
  try {
    const [reputationHosts, board] = await Promise.all([getReputationHostsCached(), getSellerBoardCached()]);
    hosts = reputationHosts.filter((h) => parseSellerHostParam(h) === h).slice(0, REPUTATION_HOST_LIMIT);
    for (const s of board.sellers) sellersByHost.set(s.host, { lastAttemptAt: s.lastAttemptAt });
  } catch {
    return new Response("sellers board unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "3600" },
    });
  }
  const urls = hosts
    .map((host) => {
      const lastAttemptAt = sellersByHost.get(host)?.lastAttemptAt;
      const lastmod = lastAttemptAt ? `\n    <lastmod>${new Date(lastAttemptAt).toISOString()}</lastmod>` : "";
      return `  <url>\n    <loc>${xmlEscape(reputationLoc(host))}</loc>${lastmod}\n    <changefreq>daily</changefreq>\n    <priority>0.5</priority>\n  </url>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "x-vet402-rows": String(hosts.length),
      "x-vet402-truncated": String(false),
    },
  });
}