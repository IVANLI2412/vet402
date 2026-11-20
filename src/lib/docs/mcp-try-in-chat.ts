// Natural-language prompts for /docs/mcp and /connect (mcp_trial/prompts.txt, 2026-11-20).
// Each publicPageUrl was checked with curl against https://vet402.com (200 or live record).

export type McpTryInChatExample = {
  prompt: string;
  publicPageUrl: string;
  publicPageLabel: string;
};

export const MCP_TRY_IN_CHAT: readonly McpTryInChatExample[] = [
  {
    prompt: "My agent is about to pay https://api.exa.ai/search via x402. Is that seller safe to pay?",
    publicPageUrl: "https://vet402.com/sellers/api.exa.ai",
    publicPageLabel: "Seller page for api.exa.ai",
  },
  {
    prompt: "Find me an x402 API that sells weather data, and tell me which one actually delivers.",
    publicPageUrl: "https://vet402.com/observatory/e/7cf89d69-70dd-4e1c-9ee3-4e68e8def7e9",
    publicPageLabel: "Public record for a delivered weather listing",
  },
  {
    prompt: "I run an x402 endpoint at https://api.exa.ai/search. Is anything wrong with it from a buyer's view?",
    publicPageUrl: "https://vet402.com/sellers/api.exa.ai",
    publicPageLabel: "Buyer view of api.exa.ai",
  },
  {
    prompt:
      "I paid an x402 seller on Base, tx 0xc624e91df3c68db93b2646d8e2156f7bbbb6a7a5b14629485ef954146af995e3. Did that payment really happen?",
    publicPageUrl: "https://basescan.org/tx/0xc624e91df3c68db93b2646d8e2156f7bbbb6a7a5b14629485ef954146af995e3",
    publicPageLabel: "Transaction on Base",
  },
  {
    prompt: "Before my agent pays ERC-8004 agent 1139099, can you check its feedback?",
    publicPageUrl: "https://vet402.com/agent/1139099",
    publicPageLabel: "Agent 1139099 on vet402",
  },
] as const;

export const MCP_DOCS_TRY_IN_CHAT_INTRO =
  "After you connect, paste one of these lines into the chat. Each example uses a URL vet402 has paid. The link under it shows the same facts on the public site.";

export const MCP_DOCS_TOOL_APPROVAL =
  "These tools read vet402 records. They do not pay or sign on chain. Approve them once in the client, for example check_x402_seller. In Cursor, open Settings, MCP, and allow vet402 tools to run without asking each time.";