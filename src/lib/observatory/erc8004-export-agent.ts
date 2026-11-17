// ============================================================
// export.csv の erc8004_agent 列（2026-11-17・段階 B）。
// 一致は段階 A と同じ: payTo と Base の owner_agents / agents.wallet の小文字完全一致。
// agent_wallet を owner より優先し、複数あれば最小の agent_id。
// ============================================================

export const ERC8004_AGENT_CAIP_CHAIN = "eip155:8453" as const;
export const ERC8004_AGENT_REGISTRY_CHAIN_ID = 8453;

/**
 * 購入行 pu に対する erc8004_agent の SQL 式（サブクエリ）。一致なしは NULL。
 * pu は x402_l1_purchases の別名であること。
 */
export function erc8004AgentColumnSql(purchaseAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(purchaseAlias)) {
    throw new Error(`erc8004AgentColumnSql: bad alias ${JSON.stringify(purchaseAlias)}`);
  }
  return `(
    SELECT format('eip155:8453:%s', chosen.agent_id::text)
    FROM (
      SELECT a.agent_id, 1 AS priority
      FROM agents a
      WHERE a.chain_id = ${ERC8004_AGENT_REGISTRY_CHAIN_ID}
        AND a.wallet IS NOT NULL
        AND a.wallet = lower(${purchaseAlias}.pay_to)
      UNION ALL
      SELECT oa.agent_id, 2 AS priority
      FROM owner_agents oa
      WHERE oa.owner = lower(${purchaseAlias}.pay_to)
    ) chosen
    ORDER BY chosen.priority, chosen.agent_id
    LIMIT 1
  )`;
}

/** CAIP 形式 eip155:8453:12345 から agentId 数字部分を取り出す。 */
export function parseErc8004AgentCaip(raw: string | null | undefined): { chain: string; agentId: string } | null {
  if (!raw) return null;
  const m = /^eip155:(\d+):(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { chain: `eip155:${m[1]}`, agentId: m[2]! };
}