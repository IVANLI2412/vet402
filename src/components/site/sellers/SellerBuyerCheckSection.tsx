import CodeBlock from "@/components/docs/CodeBlock";
import { firstBuyerCheckUrl } from "@/lib/sellers/buyer-check";

/**
 * Buyer-side check call for the seller page (2026-11-16 funnel r2 experiment).
 * The page had only the seller-side badge snippet, so a buyer reading the record had no copyable next step.
 */
export default function SellerBuyerCheckSection({
  host,
  listings,
}: {
  host: string;
  listings: { resourceUrl: string; method: string | null }[];
}) {
  const first = firstBuyerCheckUrl(listings);
  if (!first) return null;
  return (
    <div className="mt-6">
      <p className="doc-p">Check {host} from your agent before it pays</p>
      <p className="doc-caption">
        No key and no wallet. The answer is ALLOW, WARN, or BLOCK, with the latest purchases vet402 recorded for this
        listing. Field list in the{" "}
        <a className="underline" href="/docs/api#endpoints">
          API docs
        </a>
        .
      </p>
      <CodeBlock label="Check this listing (curl)" code={`curl -s "${first}"`} />
    </div>
  );
}
