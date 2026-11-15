import type { Metadata } from "next";
import Link from "next/link";
import { TradeDisputePanel } from "@/components/connect/TradeDisputePanel";
import { P2_CLAIMS_NOTE, P2_DISPUTE_PAGE_PATH } from "@/lib/observatory/trade-dispute";
import { p2PageMode } from "@/lib/observatory/p2-live";
import { pageMetadata } from "@/lib/seo";
import styles from "../connect.module.css";

export const metadata: Metadata = pageMetadata({
  title: "Trade records (draft)",
  description:
    "Each side's signed claim and the chain facts at a fixed block for one x402 auth-capture trade on Base Sepolia testnet.",
  path: P2_DISPUTE_PAGE_PATH,
  noindex: true,
});

const draftNote =
  p2PageMode() === "draft"
    ? "Draft on Base Sepolia testnet. vet402 lists what each side signed and what the chain shows at readAtBlock. vet402 does not assign blame."
    : "Live on public testnet.";

export default function TradeDisputePage() {
  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <p className={styles.lede}>{draftNote}</p>
        <h1>One trade, both sides</h1>
        <p>
          vet402 keeps signed claims per trade id (the auth-capture payment info hash). The public JSON shows each side&apos;s
          current claim and history plus chain facts read again at one fixed block on each GET. Response bodies and headers do
          not appear on this page.
        </p>
        <p>{P2_CLAIMS_NOTE}</p>
        <TradeDisputePanel />
        <p className={styles.foot}>
          <Link href="/connect" className={styles.link}>
            Back to Connect
          </Link>
        </p>
      </article>
    </main>
  );
}