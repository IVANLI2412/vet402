import { MCP_TRY_IN_CHAT, MCP_DOCS_TRY_IN_CHAT_INTRO, MCP_DOCS_TOOL_APPROVAL } from "@/lib/docs/mcp-try-in-chat";
import styles from "@/app/connect/connect.module.css";

export function TryInChatConnect() {
  return (
    <section className={styles.stack} aria-labelledby="connect-try-chat-heading">
      <h2 id="connect-try-chat-heading" className={styles.stackHeading}>
        Try in chat
      </h2>
      <p className={styles.intro}>{MCP_DOCS_TRY_IN_CHAT_INTRO}</p>
      <ol className={styles.keylessList}>
        {MCP_TRY_IN_CHAT.map((ex) => (
          <li key={ex.prompt} className={styles.keylessItem}>
            <p className={styles.keylessLabel}>&ldquo;{ex.prompt}&rdquo;</p>
            <p className={styles.intro}>
              <a href={ex.publicPageUrl} className={styles.link}>
                {ex.publicPageLabel}
              </a>
            </p>
          </li>
        ))}
      </ol>
      <p className={styles.intro}>{MCP_DOCS_TOOL_APPROVAL}</p>
    </section>
  );
}