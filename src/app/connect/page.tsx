import type { Metadata } from "next";
import Link from "next/link";
import TrackView from "@/components/site/TrackView";
import ConnectChooser from "@/components/connect/ConnectChooser";
import MonoCode from "@/components/connect/MonoCode";
import {
  CONNECT_CHOICES,
  CONNECT_KEYLESS_CHECK_CURL,
  CONNECT_KEYLESS_SDK,
  CONNECT_LEAD,
  CONNECT_MCP,
  CONNECT_PASTE_HREF,
  CONNECT_SIGNUP_HREF,
} from "@/lib/connect/snippets";
import { pageMetadata } from "@/lib/seo";
import styles from "./connect.module.css";

// 2026-11-08 製品の殻: 買う側・売る側・両方を選ぶ入口。説明と手順だけで、お金は動かさない。
// スニペットの出典と検査は src/lib/connect/snippets.ts と tests/connect-page.test.ts。
export const metadata: Metadata = pageMetadata({
  title: "Connect",
  description: `${CONNECT_LEAD} Start as a buyer, a seller or both, with curl, TypeScript, Python, MCP or no code.`,
  path: "/connect",
});

export default function ConnectPage() {
  return (
    <main className={styles.page}>
      <TrackView event="connect_view" />
      <article className={styles.article}>
        <div>
          <h1>{CONNECT_LEAD}</h1>
          <p className={styles.lede}>
            vet402 pays x402 sellers itself and keeps a public record of what came back. Pick your side and start in three steps.
          </p>
          <div className={styles.rule} />
        </div>

        <section className={styles.keyless} aria-labelledby="connect-keyless-heading">
          <h2 id="connect-keyless-heading" className={styles.sectionHeading}>
            Three ways that work without a key today
          </h2>
          <ol className={styles.keylessList}>
            <li className={styles.keylessItem}>
              <p className={styles.keylessLabel}>
                <code className={styles.inlineCode}>GET /api/v1/check?url=…</code>
              </p>
              <MonoCode code={CONNECT_KEYLESS_CHECK_CURL} label="curl check without a key" />
            </li>
            <li className={styles.keylessItem}>
              <p className={styles.keylessLabel}>
                The paste field on the{" "}
                <Link href={CONNECT_PASTE_HREF} className={styles.link}>
                  home page
                </Link>
              </p>
            </li>
            <li className={styles.keylessItem}>
              <p className={styles.keylessLabel}>The vet402 SDK</p>
              <MonoCode code={CONNECT_KEYLESS_SDK} label="TypeScript check without a key" />
            </li>
          </ol>
        </section>

        <section className={styles.stack} aria-labelledby="connect-mcp-heading">
          <h2 id="connect-mcp-heading" className={styles.stackHeading}>
            {CONNECT_MCP.stack}
          </h2>
          <p className={styles.intro}>{CONNECT_MCP.intro}</p>
          <MonoCode code={CONNECT_MCP.code} label="MCP config without a key" />
        </section>

        <ConnectChooser choices={CONNECT_CHOICES} signupHref={CONNECT_SIGNUP_HREF} />

        <p className={styles.foot}>
          Full reference:{" "}
          <Link href="/docs/api" className={styles.link}>
            API
          </Link>{" "}
          and{" "}
          <Link href="/docs/mcp" className={styles.link}>
            hosted MCP
          </Link>
          .
        </p>
      </article>
    </main>
  );
}