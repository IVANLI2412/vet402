// ADVICE §5.2: same five prompts on /docs/mcp, /connect, and the home paste MCP tab.

export const MCP_READ_ONLY_LINE =
  "These tools only read public records. They do not pay, sign, or move funds. If your client asks you to approve a tool, approve it as a read." as const;

export const MCP_REFUSED_SECTION =
  "If Cursor asks you to approve a vet402 tool and you declined, the check did not run. The server does not pay either way. Re-run the prompt and approve the read, or call GET /api/v1/check without MCP." as const;

export const MCP_CONNECT_STEPS = [
  "Add the config (JSON, claude mcp add, or Claude.ai connector).",
  "Restart or reload the client so vet402 appears in the tool list.",
  "Paste one of the prompts below. When asked to approve, the tool is a read.",
] as const;

const PROMPT_EXA =
  "Using the vet402 tools, check whether https://api.exa.ai/search delivers after payment. Tell me the verdict (ALLOW, WARN, or BLOCK) and the date of the last delivered paid test.";

const PROMPT_FIND =
  "Using vet402, find x402 sellers that delivered in the last 30 days and whose listing is about web search. Name at most five URLs and their delivered counts.";

const PROMPT_HOST =
  "Using vet402, check my host llm.gedx402.com: which listings has vet402 paid, and what failed on my side if anything?";

const PROMPT_EXPLAIN =
  "Using vet402, explain why URL {paste} is WARN or BLOCK in one short paragraph. Give the reason texts instead of only the reason codes.";

const PROMPT_PROOF =
  "Using vet402, read this payment proof: network eip155:8453, transaction {tx}. Does the on-chain transfer match the seller receipt? Do not pay anyone.";

export type McpFirstPrompt = { id: string; prompt: string };

export const MCP_FIRST_PROMPTS: readonly McpFirstPrompt[] = [
  { id: "one_url", prompt: PROMPT_EXA },
  { id: "find_search", prompt: PROMPT_FIND },
  { id: "seller_host", prompt: PROMPT_HOST },
  { id: "explain_verdict", prompt: PROMPT_EXPLAIN },
  { id: "payment_proof", prompt: PROMPT_PROOF },
] as const;

export function mcpCheckPromptForUrl(url: string): string {
  const u = url.trim();
  return `Using vet402 (read-only, it does not pay), does ${u} deliver after payment? Quote the verdict and the last delivery date.`;
}