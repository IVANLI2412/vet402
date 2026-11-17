-- ERC-8004 Identity Registry agents on Ethereum and BNB Chain (2026-11-10).
-- Written only by src/lib/indexer/erc8004-chain-indexer.ts via /api/cron/index-owners.
-- Safe to re-run:
--   psql "$DATABASE_URL" -f scripts/sql/2026-11-17-erc8004-chain-agents.sql
CREATE TABLE IF NOT EXISTS erc8004_chain_agents (
  chain_id integer NOT NULL,
  agent_id bigint NOT NULL,
  owner text,
  wallet text,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (chain_id, agent_id)
);

CREATE INDEX IF NOT EXISTS erc8004_chain_agents_owner_idx
  ON erc8004_chain_agents (chain_id, owner);

CREATE INDEX IF NOT EXISTS erc8004_chain_agents_wallet_idx
  ON erc8004_chain_agents (chain_id, wallet);