import type { Metadata } from "next";
import { PricingSection } from "@/components/site/PricingSection";
import { pageMetadata } from "@/lib/seo";

const TITLE = "vet402 pricing: free x402 seller checks, paid limits";
const DESCRIPTION =
  "vet402 access tiers: free x402 seller checks without a key, and paid plans with more score lookups per month on the score API.";

export const metadata: Metadata = {
  ...pageMetadata({
    title: TITLE,
    description: DESCRIPTION,
    path: "/pricing",
  }),
  title: { absolute: TITLE },
};

export default function PricingPage() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <h1 className="doc-title mt-8">vet402 pricing</h1>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        <PricingSection className="mt-8" titleId="pricing-standalone-title" />
      </article>
    </main>
  );
}