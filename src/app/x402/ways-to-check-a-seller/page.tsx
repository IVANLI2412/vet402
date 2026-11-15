import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { articleJsonLd, breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";
import { getObservatoryStatsCached } from "@/lib/observatory/cached-reads";
import { CHECK_SELLER } from "@/components/site/x402-answers";

const PATH = "/x402/ways-to-check-a-seller";
const TITLE = "Ways to check an x402 seller before paying | vet402";
const H1 = "Ways to check an x402 seller before paying";
const DESCRIPTION =
  "Five ways to learn about an x402 seller before paying: the payment flow, the 402 response, public indexes, and vet402 purchase records.";

const CITED_2026_11_15 = "2026-11-15 UTC";

export const metadata: Metadata = {
  ...pageMetadata({
    title: TITLE,
    description: DESCRIPTION,
    path: PATH,
  }),
  title: { absolute: TITLE },
};

export default async function WaysToCheckSellerPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const stats = await getObservatoryStatsCached().catch(() => null);
  const article = articleJsonLd({
    headline: H1,
    description: DESCRIPTION,
    path: PATH,
    datePublished: "2026-11-16",
  });
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "x402", path: "/x402" },
    { name: "Ways to check a seller", path: PATH },
  ]);

  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }} />
        <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }} />

        <div className="doc-head doc-head-compact">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Before an agent pays</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
            <span>2026-11-16</span>
          </div>
        </div>

        <h1 className="doc-title mt-8">{H1}</h1>
        <p className="doc-p">
          Each option below states what to look at, when to look at it, and where the description comes from.
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <h2 className="sec-head">
          <span className="sec-no">1.</span>
          <span>Pay and read the response</span>
        </h2>
        <p className="doc-p">
          In the x402 flow, the buyer pays and then reads the response. Look at this when I am already in a payment flow and need the post-payment body.
        </p>
        <p className="doc-p text-brand-lift">
          Source:{" "}
          <a href="https://docs.x402.org/" className="underline">
            docs.x402.org
          </a>{" "}
          (retrieved {CITED_2026_11_15})
        </p>

        <h2 className="sec-head">
          <span className="sec-no">2.</span>
          <span>Read the 402 yourself</span>
        </h2>
        <p className="doc-p">
          The 402 response carries price, payTo, network, and scheme. Look at this before signing, to see what the wall declared.
        </p>
        <p className="doc-p text-brand-lift">
          Source:{" "}
          <a href="https://docs.x402.org/" className="underline">
            docs.x402.org
          </a>{" "}
          (retrieved {CITED_2026_11_15})
        </p>

        <h2 className="sec-head">
          <span className="sec-no">3.</span>
          <span>x402scan</span>
        </h2>
        <p className="doc-p">Look at the public index when I want a cross-seller view of activity and origins.</p>
        <blockquote className="doc-p border-l-2 border-brand-lift pl-4 text-brand">
          <p>Explore the x402 ecosystem. View transactions, sellers, origins and resources.</p>
        </blockquote>
        <p className="doc-p text-brand-lift">
          Source: meta description on{" "}
          <a href="https://www.x402scan.com/" className="underline">
            x402scan.com
          </a>{" "}
          (retrieved {CITED_2026_11_15})
        </p>

        <h2 className="sec-head">
          <span className="sec-no">4.</span>
          <span>Watch402</span>
        </h2>
        <p className="doc-p">Look at the public listing index when I want Bazaar listings checked on a schedule.</p>
        <blockquote className="doc-p border-l-2 border-brand-lift pl-4 text-brand">
          <p>Every x402 listing on the Bazaar, checked daily. Publicly.</p>
        </blockquote>
        <p className="doc-p text-brand-lift">
          Source: heading on{" "}
          <a href="https://watchx402.com/" className="underline">
            watchx402.com
          </a>{" "}
          (retrieved {CITED_2026_11_15})
        </p>

        <h2 className="sec-head">
          <span className="sec-no">5.</span>
          <span>vet402</span>
        </h2>
        <p className="doc-p">
          vet402 pays with real x402 purchases and publishes the outcome of each purchase as a record. Look at this when I want purchase outcomes vet402 measured with its own funds.
        </p>
        {stats ? (
          <p className="doc-p">
            As of {stats.readAt.slice(0, 10)}, the public register lists {stats.activeEndpoints.toLocaleString()} active records vet402 can probe and buy from.
          </p>
        ) : null}
        <p className="doc-p">
          <Link href={CHECK_SELLER.path} className="underline">
            {CHECK_SELLER.h1}
          </Link>
          {" · "}
          <Link href="/observatory" className="underline">
            Observatory
          </Link>
        </p>

        <p className="doc-p mt-8 text-brand-lift">Records are measurements, not a guarantee.</p>
      </article>
    </main>
  );
}