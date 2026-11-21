import { MCP_FIRST_PROMPTS } from "@/lib/docs/mcp-first-prompts";
import { MCP_TRY_IN_CHAT, MCP_DOCS_TRY_IN_CHAT_INTRO } from "@/lib/docs/mcp-try-in-chat";
import { PromptCopyButton } from "@/components/docs/PromptCopyButton";

export function TryInChat() {
  return (
    <section id="try-in-chat" className="scroll-mt-32 space-y-3">
      <h2 className="sec-head">Try in chat</h2>
      <p className="text-[0.84375rem] text-brand">{MCP_DOCS_TRY_IN_CHAT_INTRO}</p>
      <ol className="list-decimal space-y-4 pl-5 text-[0.84375rem] text-brand">
        {MCP_TRY_IN_CHAT.map((ex, i) => (
          <li key={ex.prompt} className="space-y-1">
            <p className="text-brand-deep">&ldquo;{ex.prompt}&rdquo;</p>
            <PromptCopyButton
              prompt={ex.prompt}
              promptId={MCP_FIRST_PROMPTS[i]?.id}
              label={`Copy prompt ${MCP_FIRST_PROMPTS[i]?.id ?? i + 1}`}
            />
            {ex.publicPageUrl && ex.publicPageLabel ? (
              <p>
                <a href={ex.publicPageUrl} className="doc-link">
                  {ex.publicPageLabel}
                </a>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}