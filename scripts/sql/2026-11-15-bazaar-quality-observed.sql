-- 2026-11-15: Bazaar の quality に「vet402 が読んだ時刻」と curated を載せる（第2波 index）。
--
-- 追加だけ（ALTER … IF NOT EXISTS）。既存の行は書き換えない。何度流しても同じ。
-- 当てる順: デプロイの前に当てる（docs/INCIDENT_RUNBOOK.md §6）。ただし新しいコードが先に出ても落ちない:
--   2 列は drizzle の表（schema.ts）に宣言せず、src/lib/observatory/catalog-bazaar-quality.ts が生の SQL で書く。列が無ければ
--   （Postgres の 42703 undefined_column）警告 1 行を出して 2 列だけ飛ばし、目録の同期は既存の列で続く。売り手ページの「Called and delivered」の節は列が無ければ隠れる。
-- 旧コードのまま当てても安全: 旧コードは列を読まず書かない（NULL 可・既定なし）。
--
-- 戻し方（runbook §6.1。まずコードを戻す（§5）だけで足りる。列を消すのは、この列を読む版を二度と出さないと決めたときだけ）:
--   psql "$DATABASE_URL" <<'SQL'
--   BEGIN;
--   ALTER TABLE x402_endpoints
--     DROP COLUMN IF EXISTS quality_observed_at,
--     DROP COLUMN IF EXISTS bazaar_curated;
--   COMMIT;
--   SQL
-- 適用: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-15-bazaar-quality-observed.sql

ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS quality_observed_at timestamptz;
ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS bazaar_curated boolean;