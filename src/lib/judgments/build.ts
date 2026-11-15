import { sql } from "drizzle-orm";
import { decide, presentDecision } from "@/lib/decision/decide";
import { lookupManualList } from "@/lib/db/customer-lists";
import { getDb } from "@/lib/db/client";
import { parsePartyId, SHA256_HEX_RE } from "@/lib/ids/canonical";
import { getResourceWithNetwork } from "@/lib/resolve/lookup";
import { rowsOf } from "@/lib/settlements/upsert";
import { toPublicJudgment, utcDayOf } from "./public-judgment";

export type JudgmentShardRow = { resource_id: string; method: string; url: string };

const SHARD_PREFIX_RE = /^[0-9a-f]{2}$/;

function shardUpperBound(prefix: string): string | null {
  const n = parseInt(prefix, 16);
  if (Number.isNaN(n) || n >= 0xff) return null;
  return (n + 1).toString(16).padStart(2, "0") + "0".repeat(62);
}

export type BuildJudgmentDeps = {
  getResourceWithNetwork: typeof getResourceWithNetwork;
  lookupManualList: typeof lookupManualList;
  decide: typeof decide;
};

const defaultBuildJudgmentDeps: BuildJudgmentDeps = {
  getResourceWithNetwork,
  lookupManualList,
  decide,
};

export async function buildJudgment(
  resourceId: string,
  day: string = utcDayOf(new Date()),
  deps: BuildJudgmentDeps = defaultBuildJudgmentDeps,
): Promise<Record<string, unknown> | null> {
  if (!SHA256_HEX_RE.test(resourceId)) return null;
  const loaded = await deps.getResourceWithNetwork(resourceId);
  if (!loaded) return null;
  const ref = loaded.ref;
  if (ref.resource_id !== resourceId) return null;
  if (ref.catalog_status !== "listed") return null;
  const listSubject = ref.payee_id ? (parsePartyId(ref.payee_id)?.address ?? null) : null;
  const list = await deps.lookupManualList(undefined, listSubject && listSubject.startsWith("0x") ? listSubject : null);
  const operatorBlacklist = list === "blacklist";
  const result = await deps.decide({
    role: "payer",
    observatoryId: ref.observatory_id,
    operatorBlacklist,
    skipScore: true,
  });
  if (!result) return null;
  return toPublicJudgment(presentDecision(result, { includeScore: false }), day);
}

export async function buildJudgmentShard(prefix: string): Promise<JudgmentShardRow[]> {
  if (!SHARD_PREFIX_RE.test(prefix)) return [];
  const db = getDb();
  if (!db) throw new Error("database_unavailable");
  const lower = `${prefix}${"0".repeat(62)}`;
  const upper = shardUpperBound(prefix);
  const whereTail = upper
    ? sql`AND resource_id < ${upper} ORDER BY resource_id ASC`
    : sql`ORDER BY resource_id ASC`;
  const rows = rowsOf<{ resource_id: string; method: string; url: string }>(
    await db.execute(sql`
      SELECT resource_id,
             coalesce(method, 'GET') AS method,
             coalesce(canonical_url, resource_url) AS url
      FROM x402_endpoints
      WHERE status = 'active'
        AND resource_id ~ '^[0-9a-f]{64}$'
        AND resource_id >= ${lower}
      ${whereTail}`),
  );
  const seen = new Set<string>();
  const out: JudgmentShardRow[] = [];
  for (const row of rows) {
    if (seen.has(row.resource_id)) continue;
    seen.add(row.resource_id);
    out.push({ resource_id: row.resource_id, method: row.method, url: row.url });
  }
  return out;
}