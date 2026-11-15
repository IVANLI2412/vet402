import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { paymentChainLabel } from "@/lib/observatory/chains";
import {
  deliveredListings,
  getReputationHostsCached,
  reputationPageEligible,
  reputationSellerPath,
} from "@/lib/sellers/reputation";
import { getSellerDetailCached } from "@/lib/sellers/cached";
import { parseSellerHostParam } from "@/lib/sellers/host";
import type { SellerDetail } from "@/lib/sellers/board";
import { sellerPath } from "@/components/site/sellers/SellersViews";
import { TableScroll } from "@/components/site/TableScroll";

type Props = { params: Promise<{ host: string }> };

function listingPath(resourceKey: string, host: string): string {
  const prefix = `${host}/`;
  if (resourceKey.startsWith(prefix)) return `/${resourceKey.slice(host.length)}`;
  const slash = resourceKey.indexOf("/");
  return slash >= 0 ? resourceKey.slice(slash) : "/";
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  const allowed = await getReputationHostsCached().catch(() => null);
  if (!allowed?.includes(host)) notFound();
  const title = `Does ${host} deliver? x402 purchase record | vet402`;
  return {
    ...pageMetadata({
      title,
      description: `vet402 purchase records for ${host}: each listing vet402 bought with a real x402 payment where the latest purchase delivered a response.`,
      path: reputationSellerPath(host),
    }),
    title: { absolute: title },
  };
}

export function ReputationSellerArticle({ detail, nonce }: { detail: SellerDetail; nonce?: string }) {
  const host = detail.host;
  const listings = deliveredListings(detail);
  const n = listings.length;
  const asOf = detail.fetchedAt.slice(0, 10);
  const path = reputationSellerPath(host);
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: host, path },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <h1 className="doc-title mt-8">Does {host} deliver?</h1>
        <p className="doc-p">
          vet402 bought from {host} with real x402 payments. At each of the {n} listings vet402 bought, the latest purchase delivered a response.
        </p>
        <p className="doc-p text-brand-lift">as of {asOf}</p>

        {listings.length > 0 ? (
          <TableScroll label={`Latest delivered purchases for ${host}`} className="mt-8">
            <table className="fact-table">
              <caption className="sr-only">Latest delivered purchase per listing</caption>
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Date (UTC)</th>
                  <th scope="col">Chain</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => {
                  const row = l.latest!;
                  const at = row.facts.attemptedAt.slice(0, 16).replace("T", " ");
                  const chain = row.facts.network ? paymentChainLabel(row.facts.network) : "unknown";
                  return (
                    <tr key={l.endpointId}>
                      <td className="font-mono text-sm">{listingPath(l.resourceKey, host)}</td>
                      <td className="whitespace-nowrap">{at}</td>
                      <td>{chain}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        ) : null}

        <p className="doc-p mt-8 text-brand-lift">Records are measurements, not a guarantee.</p>
        <p className="doc-p">
          <Link href={sellerPath(host)} className="underline">
            Full purchase record for {host}
          </Link>
        </p>
      </article>
    </main>
  );
}

export default async function ReputationSellerPage({ params }: Props) {
  const { host: raw } = await params;
  const host = parseSellerHostParam(raw);
  if (!host) notFound();
  const allowed = await getReputationHostsCached().catch(() => null);
  if (!allowed?.includes(host)) notFound();

  const detail = await getSellerDetailCached(host).catch(() => null);
  if (!detail || !reputationPageEligible(detail)) notFound();

  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <ReputationSellerArticle detail={detail} nonce={nonce} />;
}