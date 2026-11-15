// ============================================================
// Bazaar の quality を「vet402 が読んだ時刻」と curated と一緒に残す（2026-11-15 第2波 index・P2）。
//
// 列: x402_endpoints.quality_observed_at・bazaar_curated（scripts/sql/2026-11-15-bazaar-quality-observed.sql）。
// drizzle の表（schema.ts）には宣言しない。宣言すると drizzle が insert と select() に全列を並べ、SQL を当てる前の本番で
// この表への書き込みが全部落ちる。だからここだけが生の SQL で 2 列を書く。列が無い（42703）ときは警告を 1 行出して飛ばし、
// 目録の同期は既存の列だけで続ける。
//
// 規則:
//   - Bazaar（cdp_bazaar）の書き込みのあとにだけ呼ぶ。Circle・MPP の同期は呼ばないので 2 列は残る。
//   - quality の 3 つのどれかがある項目は quality_observed_at = その書き込みの時刻。3 つとも無ければ前の値を残す。
//   - bazaar_curated は項目の curated をそのまま写す（curated の無い Bazaar の項目は false。true から false にも戻る）。
//   - 対象の行は、その鍵の cdp_bazaar か circle_discovery の行（2 つの目録は resource_key で 1 行を共有する）。MPP の行は触らない。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { logServerWarnSafe } from "@/lib/util/log-safe";
import type { ParsedCatalogItem } from "./catalog-source";

export function itemHasBazaarQuality(item: ParsedCatalogItem): boolean {
  return item.qualityCalls30d !== null || item.qualityPayers30d !== null || item.qualityLastCalledAt !== null;
}

type Exec = { execute: (query: SQL) => Promise<unknown> };

export type BazaarQualityMetaResult =
  | { status: "written"; rows: number }
  | { status: "skipped_missing_columns" }
  | { status: "nothing_to_write" };

const CHUNK = 500;

/** 同じ過程で警告を何度も出さない（1 回の同期で 1 行）。 */
let warnedMissing = false;

/** 試験の差し替え口: 警告を出した印を戻す。 */
export function __resetBazaarQualityWarningForTests(): void {
  warnedMissing = false;
}

/**
 * 書いた Bazaar の項目について、2 列を生の SQL で書く。列が無ければ書かずに skipped_missing_columns を返す（投げない）。
 * 列が無い以外の失敗は投げる（呼び手が既存のログに載せる）。
 */
export async function writeBazaarQualityMeta(
  db: Exec,
  items: readonly ParsedCatalogItem[],
  at: Date,
  warn: (line: string) => void = (line) => logServerWarnSafe("observatory.catalog-sync.quality_meta", line),
): Promise<BazaarQualityMetaResult> {
  const byKey = new Map<string, ParsedCatalogItem>();
  for (const item of items) if (item.resourceKey && !byKey.has(item.resourceKey)) byKey.set(item.resourceKey, item);
  if (byKey.size === 0) return { status: "nothing_to_write" };
  const atIso = at.toISOString();
  const list = [...byKey.values()];
  let rows = 0;
  try {
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const values = sql.join(
        // 引数には型を付ける。本番の neon-http は引数を型なしで送り、VALUES の中の型なしは text になる（CASE WHEN が 42804 で落ちた・
        // 2026-11-16 独立検証。tests/bazaar-quality-untyped-params.pg.test.ts）。catalog-sync.ts の共有行の VALUES と同じ書き方。
        chunk.map((item) => sql`(${item.resourceKey}::text, ${itemHasBazaarQuality(item)}::boolean, ${item.bazaarCurated === true}::boolean)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE x402_endpoints e
        SET quality_observed_at = CASE WHEN v.has_quality THEN ${atIso}::timestamptz ELSE e.quality_observed_at END,
            bazaar_curated = v.curated
        FROM (VALUES ${values}) AS v(resource_key, has_quality, curated)
        WHERE e.resource_key = v.resource_key AND e.source IN ('cdp_bazaar', 'circle_discovery')`);
      rows += chunk.length;
    }
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    if (!warnedMissing) {
      warnedMissing = true;
      warn(
        "x402_endpoints.quality_observed_at/bazaar_curated missing, apply scripts/sql/2026-11-15-bazaar-quality-observed.sql (sync continues without them)",
      );
    }
    return { status: "skipped_missing_columns" };
  }
  return { status: "written", rows };
}
