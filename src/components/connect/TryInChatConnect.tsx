import { MCP_FIRST_PROMPTS } from "@/lib/docs/mcp-first-prompts";
import { MCP_TRY_IN_CHAT, MCP_DOCS_TRY_IN_CHAT_INTRO, MCP_DOCS_TOOL_APPROVAL } from "@/lib/docs/mcp-try-in-chat";
import { PromptCopyButton } from "@/components/docs/PromptCopyButton";
import styles from "@/app/connect/connect.module.css";

export function TryInChatConnect() {
  return (
    <section className={styles.stack} aria-labelledby="connect-try-chat-heading">
      <h2 id="connect-try-chat-heading" className={styles.stackHeading}>
        Try in chat
      </h2>
      <p className={styles.intro}>{MCP_DOCS_TRY_IN_CHAT_INTRO}</p>
      <ol className={styles.keylessList}>
        {MCP_TRY_IN_CHAT.map((ex, i) => (
          <li key={ex.prompt} className={styles.keylessItem}>
            <p className={styles.keylessLabel}>&ldquo;{ex.prompt}&rdquo;</p>
            <PromptCopyButton prompt={ex.prompt} label={`Copy prompt ${MCP_FIRST_PROMPTS[i]?.id ?? i + 1}`} />
            {ex.publicPageUrl && ex.publicPageLabel ? (
              <p className={styles.intro}>
                <a href={ex.publicPageUrl} className={styles.link}>
                  {ex.publicPageLabel}
                </a>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <p className={styles.intro}>{MCP_DOCS_TOOL_APPROVAL}</p>
    </section>
  );
}