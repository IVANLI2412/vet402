# Installing the vet402 MCP server

vet402 runs a hosted, read-only MCP server at `https://vet402.com/mcp` (Streamable HTTP). There is nothing to clone, build or install, and no API key or wallet is needed. The tools never sign or send a payment.

## Cline

Add this entry to `cline_mcp_settings.json` (Cline: MCP Servers, then Configure MCP Servers):

```json
{
  "mcpServers": {
    "vet402": {
      "type": "streamableHttp",
      "url": "https://vet402.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Keep `"type": "streamableHttp"`. Cline reads a `url` entry with no type as SSE.

## Other MCP clients

Any client that supports remote Streamable HTTP servers can use the same URL:

```json
{
  "mcpServers": {
    "vet402": { "type": "http", "url": "https://vet402.com/mcp" }
  }
}
```

Claude Code: `claude mcp add --transport http vet402 https://vet402.com/mcp`

## Check that it works

After the server shows as connected, the client should list four tools:

| Tool | What it returns |
|---|---|
| `check_x402_seller` | What happened each time vet402 paid one x402 URL: chain, whether content came back, and the transaction |
| `check_my_x402_endpoint` | The same record for every listing on one seller's host |
| `check_payment_proof` | Reads a `PAYMENT-RESPONSE` header on its chain and returns from, to, asset and amount |
| `find_x402_sellers` | x402 sellers vet402 paid and got content from in the last 30 days, matched to a `query` |

A quick test prompt: "Use find_x402_sellers with the query weather."

The same data is available without MCP at `https://vet402.com/api/v1/check?url=<x402 URL>`. Method and data license: https://vet402.com/observatory/methodology
