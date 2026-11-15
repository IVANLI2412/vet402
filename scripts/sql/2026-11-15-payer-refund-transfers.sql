-- vet402 2026-11-15 — 売り手の payTo から vet402 の Base 支払元へ戻った USDC 転送を記録する（C4 返金率）。
--
-- なぜ: 届かなかった settled 購入のあと、売り手が USDC を vet402 の払う側へ返したかをオンチェーンで数える。
-- 第三者の有料索引は使わず、既存の LOG_SCAN 経路だけで Transfer を読む。
--
-- 追加のみ。Safe to re-run.
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-15-payer-refund-transfers.sql
CREATE TABLE IF NOT EXISTS x402_payer_refund_transfers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chain         text        NOT NULL,
  tx_hash       text        NOT NULL,
  log_index     integer     NOT NULL,
  from_address  text        NOT NULL,
  to_address    text        NOT NULL,
  asset         text        NOT NULL,
  amount        text        NOT NULL,
  block_number  bigint      NOT NULL,
  block_time    timestamptz NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS x402_payer_refund_transfers_chain_tx_log_idx
  ON x402_payer_refund_transfers (chain, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS x402_payer_refund_transfers_from_address_idx
  ON x402_payer_refund_transfers (from_address);