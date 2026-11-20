// ADVICE §5.2 prompts for /docs/mcp and /connect (FIX UX2 P0-5).

import { MCP_FIRST_PROMPTS, MCP_READ_ONLY_LINE } from "@/lib/docs/mcp-first-prompts";

export type McpTryInChatExample = {
  prompt: string;
  publicPageUrl?: string;
  publicPageLabel?: string;
};

export const MCP_TRY_IN_CHAT: readonly McpTryInChatExample[] = MCP_FIRST_PROMPTS.map((p) => ({
  prompt: p.prompt,
}));

export const MCP_DOCS_TRY_IN_CHAT_INTRO =
  "After you connect, paste one of these lines into the chat. Approve each tool as a read when the client asks.";

export const MCP_DOCS_TOOL_APPROVAL = `${MCP_READ_ONLY_LINE} In Cursor, open Settings, MCP, and allow vet402 tools to run without asking each time.`;