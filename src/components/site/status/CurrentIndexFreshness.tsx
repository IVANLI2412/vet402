import { readChainFreshness } from "@/lib/health/chain-freshness";
import {
  publicSettlementsIndexOf,
  settlementsIndexHeadline,
} from "@/lib/health/public-index-freshness";

/** Shown in /status section 1 so "ok" is read together with index lag (G2 availability). */
export async function CurrentIndexFreshness() {
  const readAt = new Date().toISOString();
  const rows = await readChainFreshness();
  if (rows === null) {
    return (
      <span className="text-brand-lift">
        Settlements index: not read when this page was built.
      </span>
    );
  }
  const headline = settlementsIndexHeadline(publicSettlementsIndexOf(rows, readAt));
  return (
    <>
      {headline}{" "}
      <span className="text-brand-lift">
        A data lag is not an outage, so it does not change the status above.
      </span>
    </>
  );
}