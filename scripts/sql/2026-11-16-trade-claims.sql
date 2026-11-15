-- vet402 2026-11-16 — P2 争いの窓口（trade_dispute_legs / trade_dispute_day_roots）。
--
-- なぜ: 買い手・売り手が署名した主張を履歴付きで残し、UTC 日ごとの commitment 連鎖で封印する。
--
-- 保存するのは争いの窓口用の署名行と日次 root だけ。第三者の秘密や生 HTTP 本文は入れない。
--
-- 順序: **この SQL を、これらの表を読むコードを本番に出す前に当てる**（docs/INCIDENT_RUNBOOK.md §6）。
-- 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-16-trade-claims.sql
--
-- 戻し方（docs/INCIDENT_RUNBOOK.md §6）: 行が無いことを確かめてから次を実行。行がある場合は §6.2 の分岐を先に作る。
--   BEGIN;
--   DROP TABLE IF EXISTS trade_dispute_legs;
--   DROP TABLE IF EXISTS trade_dispute_day_roots;
--   COMMIT;

DO $$
DECLARE
  legs_expected constant text[] := ARRAY[
    'id', 'trade_id', 'side', 'chain', 'payer', 'receiver', 'payment_info_operator',
    'signer', 'payment_tx', 'delivery', 'received_body_sha256', 'payment_seen',
    'delivered_body_sha256', 'seller_receipt_commitment', 'seller_receipt_signature',
    'seller_receipt_issued', 'commitment', 'issued', 'accepted_at'
  ];
  roots_expected constant text[] := ARRAY[
    'day', 'root_hash', 'prev_root', 'entry_count', 'payload', 'sealed_at'
  ];
  legs_have text[];
  roots_have text[];
  legs_extra text[];
  roots_extra text[];
  col text;
BEGIN
  IF to_regclass('public.trade_dispute_legs') IS NOT NULL THEN
    FOREACH col IN ARRAY legs_expected LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trade_dispute_legs' AND column_name = col
      ) THEN
        RAISE EXCEPTION 'trade_dispute_legs exists with a different shape: missing column %', col;
      END IF;
    END LOOP;

    SELECT ARRAY_AGG(column_name::text ORDER BY column_name)
    INTO legs_have
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_dispute_legs';

    SELECT ARRAY_AGG(c ORDER BY c)
    INTO legs_extra
    FROM unnest(legs_have) AS c
    WHERE NOT (c = ANY (legs_expected));

    IF legs_extra IS NOT NULL AND array_length(legs_extra, 1) > 0 THEN
      IF legs_extra && ARRAY['payer_state', 'operator', 'chain_collected', 'pre_approval_expiry']::text[] THEN
        RAISE EXCEPTION 'trade_dispute_legs exists with a different shape: legacy p2b/p2c columns %', legs_extra;
      END IF;
      RAISE EXCEPTION 'trade_dispute_legs exists with a different shape: extra columns %', legs_extra;
    END IF;
  END IF;

  IF to_regclass('public.trade_dispute_day_roots') IS NOT NULL THEN
    FOREACH col IN ARRAY roots_expected LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trade_dispute_day_roots' AND column_name = col
      ) THEN
        RAISE EXCEPTION 'trade_dispute_day_roots exists with a different shape: missing column %', col;
      END IF;
    END LOOP;

    SELECT ARRAY_AGG(column_name::text ORDER BY column_name)
    INTO roots_have
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_dispute_day_roots';

    SELECT ARRAY_AGG(c ORDER BY c)
    INTO roots_extra
    FROM unnest(roots_have) AS c
    WHERE NOT (c = ANY (roots_expected));

    IF roots_extra IS NOT NULL AND array_length(roots_extra, 1) > 0 THEN
      RAISE EXCEPTION 'trade_dispute_day_roots exists with a different shape: extra columns %', roots_extra;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS trade_dispute_legs (
  id bigserial PRIMARY KEY,
  trade_id text NOT NULL,
  side text NOT NULL,
  chain text NOT NULL,
  payer text NOT NULL,
  receiver text NOT NULL,
  payment_info_operator text NOT NULL,
  signer text NOT NULL,
  payment_tx text NOT NULL,
  delivery text NOT NULL,
  received_body_sha256 text,
  payment_seen text,
  delivered_body_sha256 text,
  seller_receipt_commitment text,
  seller_receipt_signature text,
  seller_receipt_issued text,
  commitment text NOT NULL,
  issued text NOT NULL,
  accepted_at timestamptz NOT NULL,
  CONSTRAINT trade_dispute_legs_side_check CHECK (side IN ('payer', 'seller')),
  CONSTRAINT trade_dispute_legs_chain_check CHECK (chain = 'eip155:84532'),
  CONSTRAINT trade_dispute_legs_trade_id_check CHECK (trade_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT trade_dispute_legs_trade_side_issued_unique UNIQUE (trade_id, side, issued)
);

CREATE INDEX IF NOT EXISTS trade_dispute_legs_trade_side_idx ON trade_dispute_legs (trade_id, side);
CREATE INDEX IF NOT EXISTS trade_dispute_legs_signer_accepted_idx ON trade_dispute_legs (signer, accepted_at);

CREATE TABLE IF NOT EXISTS trade_dispute_day_roots (
  day date PRIMARY KEY,
  root_hash text NOT NULL,
  prev_root text,
  entry_count integer NOT NULL,
  payload text NOT NULL,
  sealed_at timestamptz NOT NULL,
  CONSTRAINT trade_dispute_day_roots_hash_check CHECK (root_hash ~ '^[0-9a-f]{64}$')
);