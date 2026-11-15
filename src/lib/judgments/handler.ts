import { NextRequest, NextResponse } from "next/server";
import { rejectUnknownQuery } from "@/lib/api/export-guard";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import type { JudgmentShardRow } from "./build";
import {
  JUDGMENT_NOT_FOUND_CACHE_CONTROL,
  JUDGMENT_PUBLIC_NOTE,
  JUDGMENT_TRANSIENT_CACHE_CONTROL,
  isTransientJudgment,
  JUDGMENT_UNAVAILABLE_CACHE_CONTROL,
  judgmentCacheControl,
  utcDayOf,
} from "./public-judgment";

const JUDGMENTS_BASE = "https://vet402.com/api/v1/judgments";
const LICENSE_LINK = "<https://creativecommons.org/licenses/by/4.0/>; rel=\"license\"";
const DESCRIBEDBY_LINK = "<https://vet402.com/docs/api#judgments>; rel=\"describedby\"";
const INDEX_SHARD_LINKS = Array.from({ length: 256 }, (_, i) => {
  const prefix = i.toString(16).padStart(2, "0");
  return { prefix, href: `${JUDGMENTS_BASE}/index-${prefix}.json` };
});

const SHARD_FILE_RE = /^index-([0-9a-f]{2})\.json$/;
const DOC_FILE_RE = /^([0-9a-f]{64})\.json$/;

export type JudgmentHandlerDeps = {
  readShard: (prefix: string, day: string) => Promise<JudgmentShardRow[]>;
  readJudgment: (resourceId: string, day: string) => Promise<Record<string, unknown> | null>;
  now: () => Date;
};

function judgmentHeaders(day: string, cacheControl: string): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "x-vet402-judgment-day": day,
    "x-vet402-license": "CC-BY-4.0",
    Link: `${LICENSE_LINK}, ${DESCRIBEDBY_LINK}`,
    "content-type": "application/json",
  };
}

function notFoundJudgment(cacheControl: string, day: string, url?: string): NextResponse {
  const body: Record<string, unknown> = url
    ? {
        error: "not_found",
        message: "No judgment for this resource on the catalog shard for today.",
        next: `https://vet402.com/api/v1/resolve?q=${encodeURIComponent(url)}`,
      }
    : { error: "not_found" };
  return NextResponse.json(body, { status: 404, headers: judgmentHeaders(day, cacheControl) });
}

function staticIndex(day: string): Record<string, unknown> {
  return {
    judgment_day: day,
    license: "CC-BY-4.0",
    id_rule:
      'resource_id is sha256("<METHOD> <canonical url>"), the same id /api/v1/resolve returns',
    file_template: "https://vet402.com/api/v1/judgments/{resource_id}.json",
    shards: INDEX_SHARD_LINKS,
    live_decision: "https://vet402.com/api/v1/resources/{resource_id}/decision?role=payer",
    note: JUDGMENT_PUBLIC_NOTE,
  };
}

function shardInListing(rows: JudgmentShardRow[], resourceId: string): JudgmentShardRow | undefined {
  return rows.find((r) => r.resource_id === resourceId);
}

export async function handleJudgmentFile(
  request: NextRequest,
  file: string,
  deps: JudgmentHandlerDeps,
): Promise<NextResponse> {
  const now = deps.now();
  const day = utcDayOf(now);
  const okCache = judgmentCacheControl(now);

  const badQuery = rejectUnknownQuery(request.nextUrl.searchParams, [], { "Cache-Control": JUDGMENT_UNAVAILABLE_CACHE_CONTROL });
  if (badQuery) return badQuery;

  if (file !== "index.json" && (file.includes("..") || file.includes("/"))) {
    return notFoundJudgment(JUDGMENT_NOT_FOUND_CACHE_CONTROL, day);
  }

  if (file === "index.json") {
    return NextResponse.json(staticIndex(day), { headers: judgmentHeaders(day, okCache) });
  }

  const shardMatch = SHARD_FILE_RE.exec(file);
  if (shardMatch) {
    const prefix = shardMatch[1];
    try {
      const rows = await deps.readShard(prefix, day);
      const listings = rows.map((r) => ({
        ...r,
        href: `${JUDGMENTS_BASE}/${r.resource_id}.json`,
      }));
      return NextResponse.json(
        { judgment_day: day, prefix, count: listings.length, listings },
        { headers: judgmentHeaders(day, okCache) },
      );
    } catch (error) {
      logServerErrorSafe("judgments", error);
      return NextResponse.json(
        { error: "judgments_unavailable" },
        { status: 503, headers: { "Cache-Control": JUDGMENT_UNAVAILABLE_CACHE_CONTROL } },
      );
    }
  }

  const docMatch = DOC_FILE_RE.exec(file);
  if (docMatch) {
    const resourceId = docMatch[1];
    const prefix = resourceId.slice(0, 2);
    try {
      const shard = await deps.readShard(prefix, day);
      const row = shardInListing(shard, resourceId);
      if (!row) return notFoundJudgment(JUDGMENT_NOT_FOUND_CACHE_CONTROL, day);
      const doc = await deps.readJudgment(resourceId, day);
      if (!doc) return notFoundJudgment(JUDGMENT_NOT_FOUND_CACHE_CONTROL, day, row.url);
      const cacheControl = isTransientJudgment(doc) ? JUDGMENT_TRANSIENT_CACHE_CONTROL : okCache;
      return NextResponse.json(doc, { headers: judgmentHeaders(day, cacheControl) });
    } catch (error) {
      logServerErrorSafe("judgments", error);
      return NextResponse.json(
        { error: "judgments_unavailable" },
        { status: 503, headers: { "Cache-Control": JUDGMENT_UNAVAILABLE_CACHE_CONTROL } },
      );
    }
  }

  return notFoundJudgment(JUDGMENT_NOT_FOUND_CACHE_CONTROL, day);
}