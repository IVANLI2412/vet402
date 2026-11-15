// Daily judgments CDN route (2026-11-15): cache, headers, redaction, no DB on request path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import type { DecisionResult } from "@/lib/decision/decide";
import { handleJudgmentFile } from "@/lib/judgments/handler";
import { makeJudgmentReaders } from "@/lib/judgments/daily-reader";
import type { JudgmentShardRow } from "@/lib/judgments/build";
import {
  judgmentCacheControl,
  secondsUntilNextUtcDay,
  toPublicJudgment,
  utcDayOf,
} from "@/lib/judgments/public-judgment";
import type { JudgmentCacheFn } from "@/lib/judgments/daily-reader";

const LISTED_ID = "a".repeat(64);
const SAMPLE_URL = "https://api.example.com/v1/data";

function makeMemoCache(): { cache: JudgmentCacheFn; reset: () => void } {
  const store = new Map<string, unknown>();
  const cache = ((fn, keys) => {
    const key = (keys ?? []).join("\0");
    return async () => {
      if (store.has(key)) return store.get(key);
      try {
        const v = await fn();
        store.set(key, v);
        return v;
      } catch (err) {
        throw err;
      }
    };
  }) as JudgmentCacheFn;
  return { cache, reset: () => store.clear() };
}

function makeHandlerDeps(opts: {
  shard: JudgmentShardRow[];
  doc: Record<string, unknown> | null;
  counts: { shard: number; doc: number };
  now: () => Date;
}) {
  const { cache } = makeMemoCache();
  const readers = makeJudgmentReaders(cache, {
    buildJudgmentShard: async () => {
      opts.counts.shard += 1;
      return opts.shard;
    },
    buildJudgment: async () => {
      opts.counts.doc += 1;
      return opts.doc;
    },
  });
  return {
    handle: (file: string, query = "") =>
      handleJudgmentFile(new NextRequest(`http://localhost/api/v1/judgments/${file}${query}`), file, {
        ...readers,
        now: opts.now,
      }),
  };
}

async function many<T>(n: number, fn: () => Promise<T>): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < n; i++) last = await fn();
  return last!;
}

test("cache: listed id 1000x hits build once each; shard miss never builds doc", async () => {
  const day = "2026-11-15";
  const now = () => new Date(`${day}T12:00:00.000Z`);
  const counts = { shard: 0, doc: 0 };
  const shard = [{ resource_id: LISTED_ID, method: "GET", url: SAMPLE_URL }];
  const doc = { judgment_day: day, recommendation: "ALLOW" };
  const { handle } = makeHandlerDeps({ shard, doc, counts, now });

  await many(1000, () => handle(`${LISTED_ID}.json`));
  assert.equal(counts.doc, 1);
  assert.equal(counts.shard, 1);

  counts.shard = 0;
  counts.doc = 0;
  const missing = "b".repeat(64);
  await many(1000, () => handle(`${missing}.json`));
  assert.equal(counts.doc, 0);
  assert.equal(counts.shard, 1);

  counts.shard = 0;
  counts.doc = 0;
  await many(1000, () => handle("index.json"));
  assert.equal(counts.shard, 0);
  assert.equal(counts.doc, 0);

  counts.shard = 0;
  counts.doc = 0;
  const nextDay = () => new Date("2026-11-16T01:00:00.000Z");
  const { handle: handle2 } = makeHandlerDeps({ shard, doc, counts, now: nextDay });
  await handle2(`${LISTED_ID}.json`);
  await handle2(`${LISTED_ID}.json`);
  assert.equal(counts.doc, 1);
  assert.equal(counts.shard, 1);
});

test("static guard: handler route and public-judgment do not import DB or IP limits", () => {
  const needles = [
    "@/lib/db",
    "getDb",
    "publicRateLimit",
    "consumeIpRateLimit",
    "recordClientUsage",
    "recordDecisionUsage",
  ];
  for (const file of [
    "src/lib/judgments/handler.ts",
    "src/app/api/v1/judgments/[file]/route.ts",
    "src/lib/judgments/public-judgment.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    for (const n of needles) assert.equal(src.includes(n), false, `${file} must not mention ${n}`);
  }
});

test("Cache-Control: 200 carries s-maxage and stale-while-revalidate; 404 has s-maxage; 503 no-store", async () => {
  const counts = { shard: 0, doc: 0 };
  const shard = [{ resource_id: LISTED_ID, method: "GET", url: SAMPLE_URL }];
  const { handle } = makeHandlerDeps({
    shard,
    doc: { ok: true },
    counts,
    now: () => new Date("2026-11-15T23:59:30.000Z"),
  });
  const ok = await handle(`${LISTED_ID}.json`);
  assert.equal(ok.status, 200);
  const cc = ok.headers.get("cache-control") ?? "";
  assert.match(cc, /s-maxage=\d+/);
  assert.match(cc, /stale-while-revalidate=86400/);
  assert.equal(secondsUntilNextUtcDay(new Date("2026-11-15T23:59:30.000Z")), 30);
  assert.match(cc, /s-maxage=300/);

  const midnight = judgmentCacheControl(new Date("2026-11-16T00:00:00.000Z"));
  assert.match(midnight, /s-maxage=86400/);

  const miss = await handle(`${"c".repeat(64)}.json`);
  assert.equal(miss.status, 404);
  assert.match(miss.headers.get("cache-control") ?? "", /s-maxage=/);

  const throwing = makeHandlerDeps({
    shard: [],
    doc: null,
    counts: { shard: 0, doc: 0 },
    now: () => new Date("2026-11-15T12:00:00.000Z"),
  });
  const readers = makeJudgmentReaders(((fn) => async () => {
    throw new Error("db down");
  }) as JudgmentCacheFn, {
    buildJudgmentShard: async () => {
      throw new Error("db down");
    },
    buildJudgment: async () => null,
  });
  const unavailable = await handleJudgmentFile(
    new NextRequest("http://localhost/api/v1/judgments/index-00.json"),
    "index-00.json",
    { ...readers, now: () => new Date("2026-11-15T12:00:00.000Z") },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  void throwing;
  for (const [k] of ok.headers.entries()) assert.equal(k.toLowerCase().startsWith("ratelimit-"), false, k);
});

test("toPublicJudgment strips internal and extra keys", () => {
  const input = {
    subject: { type: "resource", id: LISTED_ID, endpoint_id: "e", observatory_id: "o", canonical_url: SAMPLE_URL, method: "GET" },
    role: "payer",
    payer: "eip155:1:0x1",
    recommendation: "ALLOW",
    reason_codes: ["l0_pass"],
    facts: {
      l0: { status: "pass", observed_at: "2026-11-15T00:00:00.000Z", dialect: null, fail_reason: null },
      l1: {
        n_delivered: 1,
        n_settled: 1,
        n_attempts: 1,
        n_inconclusive: 0,
        n_probe_error: 0,
        p50_ms: null,
        p95_ms: null,
        last_purchase_id: null,
        observed_at: null,
        last_attempt_at: null,
      },
      l2: {
        status: "undeclared",
        declaration_hash: null,
        response_hash: null,
        diff_hash: null,
        missing_keys: null,
        observed_at: null,
      },
      email: "hidden@example.com",
      apiKey: "secret-key",
      trustScore: 99,
      caller_policy: { verdict: "BLOCK", reason_codes: ["price_above_ceiling"] },
      cacheExpiresAt: "2026-11-15T00:05:00.000Z",
      score: { raw: 12 },
    },
    spending_halted: false,
    not_attempted_reason: null,
    freshness: { l0: "2026-11-15T00:00:00.000Z", l1: null, l2: null },
    l1_basis: null,
    verified_terms: null,
    evidence: [
      {
        level: "L1",
        source: "vet402",
        url: "https://api.example.com/v1/data",
        score: 1,
        caller_policy: { verdict: "BLOCK" },
        cacheExpiresAt: "2026-11-15T00:05:00.000Z",
        payer: "eip155:1:0xdead",
      },
    ],
    score: { trustScore: 99, recommendation: "ALLOW", deprecated: true, superseded_by: "recommendation", note: "n" },
    degraded: false,
    policy: "allow_only",
    caller_policy: { verdict: "ALLOW", reason_codes: [], applied: true, not_evaluated: [] },
    rules_version: "test",
    registry: { status: "off", tx_hash: null },
    scoredAt: "2026-11-15T00:00:00.000Z",
    cacheExpiresAt: "2026-11-15T00:05:00.000Z",
    disclaimer: "Scores are opinions.",
  } as unknown as DecisionResult;

  const out = toPublicJudgment(input, "2026-11-15");
  const text = JSON.stringify(out);
  for (const bad of ["caller_policy", "cacheExpiresAt", "trustScore", "apiKey", "email", "contact", "score"]) {
    assert.equal(text.includes(`"${bad}"`), false, `leaked ${bad}`);
  }
  assert.equal(text.includes('"payer":'), false, "leaked payer key");
  assert.equal(text.includes("secret-key"), false);
  assert.equal(text.includes("hidden@example.com"), false);
  assert.equal(out.recommendation, "ALLOW");
  assert.equal(out.judgment_day, "2026-11-15");
  assert.match(String(out.live), /\/decision\?role=payer/);
});

test("file names and query guard", async () => {
  const { handle } = makeHandlerDeps({
    shard: [],
    doc: null,
    counts: { shard: 0, doc: 0 },
    now: () => new Date("2026-11-15T12:00:00.000Z"),
  });
  for (const file of [
    `${"A".repeat(64)}.json`,
    `${"a".repeat(63)}.json`,
    "deadbeef.json",
    "index-zz.json",
    "../index.json",
    "index-00",
  ]) {
    const res = await handle(file);
    assert.equal(res.status, 404, file);
  }
  const badQuery = await handle("index.json", "?cb=1");
  assert.equal(badQuery.status, 400);
  assert.equal(badQuery.headers.get("cache-control"), "no-store");
  const body = await badQuery.json();
  assert.equal(body.error, "invalid_query");
});

test("utcDayOf matches JUDGMENT_DAY_RE", () => {
  const d = utcDayOf(new Date("2026-11-15T23:59:59.000Z"));
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d, "2026-11-15");
});

test("cache: shard build failure is not memoized; retry after throw succeeds", async () => {
  const day = "2026-11-15";
  const now = () => new Date(`${day}T12:00:00.000Z`);
  let shardCalls = 0;
  const { cache, reset } = makeMemoCache();
  const readers = makeJudgmentReaders(cache, {
    buildJudgmentShard: async () => {
      shardCalls += 1;
      if (shardCalls === 1) throw new Error("database_unavailable");
      return [];
    },
    buildJudgment: async () => null,
  });

  const fail = await handleJudgmentFile(
    new NextRequest("http://localhost/api/v1/judgments/index-00.json"),
    "index-00.json",
    { ...readers, now },
  );
  assert.equal(fail.status, 503);
  assert.equal(shardCalls, 1);

  const ok = await handleJudgmentFile(
    new NextRequest("http://localhost/api/v1/judgments/index-00.json"),
    "index-00.json",
    { ...readers, now },
  );
  assert.equal(ok.status, 200);
  assert.equal(shardCalls, 2);
  void reset;
});

test("buildJudgment: operator blacklist uses key-less list lookup and decide shape", async () => {
  const { buildJudgment } = await import("@/lib/judgments/build");
  const observatoryId = "obs-test-uuid";
  const payee = "eip155:8453:0x00000000000000000000000000000000000000dd";
  const resourceId = "c".repeat(64);
  let listWallet: string | null = null;
  type DecideReq = Parameters<typeof import("@/lib/decision/decide").decide>[0];
  let decideInput: DecideReq | null = null;

  const doc = await buildJudgment(resourceId, "2026-11-15", {
    getResourceWithNetwork: async () => ({
      ref: {
        endpoint_id: "e",
        resource_id: resourceId,
        observatory_id: observatoryId,
        canonical_url: "https://example.test/x",
        method: "GET",
        payee_id: payee,
        catalog_status: "listed",
        first_seen: null,
        last_seen: null,
      },
      network: "eip155:8453",
    }),
    lookupManualList: async (_apiKeyId, wallet) => {
      listWallet = wallet;
      return "blacklist";
    },
    decide: async (req) => {
      decideInput = req;
      return {
        subject: { type: "resource", id: resourceId, endpoint_id: "e", observatory_id: observatoryId, canonical_url: "https://example.test/x", method: "GET" },
        role: "payer",
        payer: null,
        recommendation: "BLOCK",
        reason_codes: ["operator_blacklist"],
        facts: { l0: { status: "unverified", observed_at: null, dialect: null, fail_reason: null } },
        spending_halted: false,
        not_attempted_reason: null,
        freshness: { l0: null, l1: null, l2: null },
        l1_basis: null,
        verified_terms: null,
        evidence: [],
        degraded: false,
        policy: "allow_only",
        rules_version: "test",
        registry: { status: "off", tx_hash: null },
        scoredAt: "2026-11-15T00:00:00.000Z",
        cacheExpiresAt: "2026-11-15T01:00:00.000Z",
        disclaimer: "Scores are opinions.",
      } as unknown as DecisionResult;
    },
  });

  assert.equal(listWallet, "0x00000000000000000000000000000000000000dd");
  assert.ok(decideInput);
  const payerReq = decideInput as Extract<DecideReq, { role: "payer" }>;
  assert.equal(payerReq.role, "payer");
  assert.equal(payerReq.operatorBlacklist, true);
  assert.equal(payerReq.skipScore, true);
  assert.equal("callerMaterial" in payerReq, false);
  assert.equal(doc?.recommendation, "BLOCK");
});
// 2026-11-15 依頼主の指摘 3: 入れ子も許可リスト。DecisionResult の型に無い鍵は、名前に関わらず落ちる。
test("toPublicJudgment: nested allowlist drops keys the DecisionResult types do not have", () => {
  const result = {
    subject: { type: "resource", id: "a".repeat(64), endpoint_id: "e", observatory_id: "o", canonical_url: "https://x.example/a", method: "GET", contactUrl: "https://seller.example/contact" },
    role: "payer",
    recommendation: "ALLOW",
    reason_codes: ["l0_pass", "l1_delivered"],
    facts: {
      l0: { status: "pass", observed_at: null, dialect: "v2", fail_reason: null, probe_token: "t0k" },
      l1: { n_delivered: 2, n_settled: 2, n_attempts: 2, n_inconclusive: 0, n_probe_error: 0, p50_ms: 1, p95_ms: 2, last_purchase_id: "p1", observed_at: null, last_attempt_at: null, ownerEmail: "owner@seller.example" },
      l2: { status: "conform", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: ["a", { leak: "x" }], observed_at: null },
      availability_7d: 1,
      availability_30d: 1,
      offer_stability: "stable",
      payees: ["eip155:8453:0xb"],
      settlement_30d_real: 1,
      settlement_30d_raw: 1,
      settlement_30d_test: 0,
      settlement_30d_measurement: 0,
      unique_payers_30d_real: 1,
      wash_dominated: false,
      API_KEY: "sk_live_should_not_leak",
    },
    spending_halted: false,
    not_attempted_reason: null,
    freshness: { l0: null, l1: null, l2: null, internal_cursor: "c" },
    l1_basis: null,
    verified_terms: { purchase_id: "p1", pay_to: "0xb", asset: "0xusdc", amount: "1000", decimals: 6, network: "eip155:8453", scheme: "exact", protocol: "x402", verified_at: "2026-11-15T00:00:00Z", signer_key: "k" },
    evidence: [
      { level: "L1", source: "vet402", purchase_id: "p1", url: "https://vet402.com/r/p1", webhook_secret: "whsec_x", block: { number: 1, timestamp: 2, rpc_url: "https://paid-rpc.example/key" } },
    ],
    degraded: false,
    policy: "allow_only",
    rules_version: "2026-11-13.1",
    registry: { status: "off", tx_hash: null, admin_note: "n" },
    scoredAt: "2026-11-15T00:00:00Z",
    cacheExpiresAt: "2026-11-15T00:05:00Z",
    disclaimer: "d",
    API_KEY: "top",
  } as unknown as DecisionResult;
  const out = toPublicJudgment(result, "2026-11-15");
  const text = JSON.stringify(out);
  for (const leaked of ["ownerEmail", "owner@seller.example", "API_KEY", "sk_live_should_not_leak", "contactUrl", "seller.example/contact", "webhook_secret", "whsec_x", "rpc_url", "paid-rpc", "probe_token", "internal_cursor", "signer_key", "admin_note", "leak", "cacheExpiresAt"]) {
    assert.equal(text.includes(leaked), false, `${leaked} leaked`);
  }
  const facts = out.facts as Record<string, Record<string, unknown>>;
  assert.equal(facts.l1.n_delivered, 2);
  assert.deepEqual(facts.l2.missing_keys, undefined, "a leaf array with an object in it is dropped whole");
  assert.deepEqual((out.evidence as Array<Record<string, unknown>>)[0].block, { number: 1, timestamp: 2 });
  assert.equal((out.verified_terms as Record<string, unknown>).amount, "1000");
  assert.equal((out.subject as Record<string, unknown>).canonical_url, "https://x.example/a");
  assert.equal(out.recommendation, "ALLOW");
});

// 2026-11-15 依頼主の指摘 2: 停止フラグの読み取り失敗（spending_halted は true に倒れる）と degraded は 1 日持たない。
test("spending_halted and degraded judgments are not cached for the day and get a short Cache-Control", async () => {
  const day = "2026-11-15";
  const now = () => new Date(`${day}T12:00:00.000Z`);
  for (const transient of [{ spending_halted: true, degraded: false }, { spending_halted: false, degraded: true }]) {
    const counts = { shard: 0, doc: 0 };
    const shard = [{ resource_id: LISTED_ID, method: "GET", url: SAMPLE_URL }];
    const { handle } = makeHandlerDeps({ shard, doc: { judgment_day: day, recommendation: "WARN", ...transient }, counts, now });
    for (let i = 0; i < 3; i++) {
      const res = await handle(`${LISTED_ID}.json`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "public, max-age=60, s-maxage=300");
    }
    assert.equal(counts.doc, 3, `a ${JSON.stringify(transient)} judgment was kept in the daily cache`);
    assert.equal(counts.shard, 1);
  }
  const counts = { shard: 0, doc: 0 };
  const { handle } = makeHandlerDeps({
    shard: [{ resource_id: LISTED_ID, method: "GET", url: SAMPLE_URL }],
    doc: { judgment_day: day, recommendation: "ALLOW", spending_halted: false, degraded: false },
    counts,
    now,
  });
  const first = await handle(`${LISTED_ID}.json`);
  await handle(`${LISTED_ID}.json`);
  assert.match(first.headers.get("cache-control") ?? "", /s-maxage=43200/);
  assert.equal(counts.doc, 1, "a normal judgment is built once per day");
});
