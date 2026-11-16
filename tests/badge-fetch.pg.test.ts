import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("badge fetch (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("badge_fetch_daily upsert counts referer host only", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { upsertBadgeFetch } = await import("@/lib/badge/fetch-stats");
    const db = getDb()!;
    const migration = readFileSync(
      join(process.cwd(), "scripts/sql/2026-11-16-keyless-callers-and-badge-fetches.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(sql`TRUNCATE badge_fetch_daily RESTART IDENTITY`);

    await upsertBadgeFetch("https://docs.example.com/page", "host");
    await upsertBadgeFetch("https://docs.example.com/other?x=1", "host");

    const raw = await db.execute(
      sql`SELECT referer_host, badge_kind, fetches::int AS fetches FROM badge_fetch_daily`,
    );
    const rows = [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as {
      referer_host: string;
      badge_kind: string;
      fetches: number;
    }[])];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.referer_host, "docs.example.com");
    assert.equal(rows[0]?.fetches, 2);
    assert.equal(rows[0]?.badge_kind, "host");
  });

  test("IPv6 literal referers are stored as (none)", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { upsertBadgeFetch, readBadgeFetches } = await import("@/lib/badge/fetch-stats");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE badge_fetch_daily RESTART IDENTITY`);

    await upsertBadgeFetch("http://[2001:db8::1]/x", "host");
    await upsertBadgeFetch("https://[::ffff:203.0.113.5]/a", "host");

    const raw = await db.execute(
      sql`SELECT referer_host, fetches::int AS fetches FROM badge_fetch_daily WHERE badge_kind = 'host'`,
    );
    const rows = rowsOf<{ referer_host: string; fetches: number }>(raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.referer_host, "(none)");
    assert.equal(rows[0]?.fetches, 2);

    const stats = await readBadgeFetches(7);
    const text = JSON.stringify(stats);
    assert.equal(text.includes("[2001:db8::1]"), false);
    assert.equal(text.includes("[::ffff:"), false);
    assert.equal(text.includes("203.0.113.5"), false);
  });

  test("referer IPs are stored as (none)", async () => {
    const { sql } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const { upsertBadgeFetch } = await import("@/lib/badge/fetch-stats");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE badge_fetch_daily RESTART IDENTITY`);

    await upsertBadgeFetch("http://203.0.113.1/badge", "host");
    const raw = await db.execute(
      sql`SELECT referer_host FROM badge_fetch_daily WHERE badge_kind = 'host'`,
    );
    const rows = [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as {
      referer_host: string;
    }[])];
    assert.equal(rows[0]?.referer_host, "(none)");
  });
}

function rowsOf<T>(raw: unknown): T[] {
  return [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];
}