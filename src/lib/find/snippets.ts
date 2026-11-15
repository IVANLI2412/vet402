export type BeforePaySnippet = { id: "ts" | "curl" | "mcp"; label: string; code: string };

const MCP_LINE = "claude mcp add --transport http vet402 https://vet402.com/mcp";

function curlQueryEncode(url: string): string {
  return encodeURIComponent(url).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function beforePaySnippets(url: string): BeforePaySnippet[] {
  return [
    {
      id: "ts",
      label: "TypeScript",
      code: `import { check } from "vet402"; const r = await check(${JSON.stringify(url)});`,
    },
    {
      id: "curl",
      label: "curl",
      code: `curl -s "https://vet402.com/api/v1/check?url=${curlQueryEncode(url)}"`,
    },
    {
      id: "mcp",
      label: "MCP",
      code: MCP_LINE,
    },
  ];
}

export const BEFORE_PAY_MCP_LINE = MCP_LINE;