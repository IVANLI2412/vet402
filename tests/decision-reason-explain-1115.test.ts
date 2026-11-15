// ============================================================
// 判定理由の英語1文・効き目・根拠・鮮度（2026-11-15・DB なし）。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REASON_CODES, reasonCodeDocOf } from "@/lib/decision/reason-codes";
import { REASON_TEXT, reasonTextOf } from "@/lib/decision/reason-text";
import { evidenceAgeOf, explainReasons } from "@/lib/decision/reason-explain";
import { decidePayer, decidePayee, type PayerOptions } from "@/lib/decision/rules";
import { buildDecision, type DecisionResult, type DecisionSubject } from "@/lib/decision/decide";
import { checkSellerOutput } from "@/lib/mcp/schemas";
import { checkSeller, MAX_STRUCTURED_BYTES, type McpDeps } from "@/lib/mcp/tools";
import type { BuyerFacts, SellerFacts, VerifiedTerms } from "@/lib/decision/types";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const SUBJECT: DecisionSubject = {
  type: "resource",
  id: "r".repeat(64),
  endpoint_id: "e".repeat(64),
  observatory_id: "00000000-0000-0000-0000-000000000001",
  canonical_url: "https://e.com/x",
  method: "GET",
};

const SELLER_BASE: SellerFacts = {
  l0: { status: "pass", observed_at: daysAgo(0.1), dialect: "v2", fail_reason: null },
  l1: {
    n_delivered: 1,
    n_settled: 1,
    n_attempts: 1,
    n_inconclusive: 0,
    n_probe_error: 0,
    p50_ms: 1,
    p95_ms: 1,
    last_purchase_id: null,
    observed_at: daysAgo(1),
    last_attempt_at: daysAgo(1),
  },
  l2: { status: "conform", declaration_hash: "d".repeat(64), response_hash: "a".repeat(64), diff_hash: null, missing_keys: null, observed_at: daysAgo(1) },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: [],
  settlement_30d_real: 0,
  settlement_30d_raw: 0,
  settlement_30d_test: 0,
  settlement_30d_measurement: 0,
  unique_payers_30d_real: 0,
  wash_dominated: false,
};

const registry = { status: "off" as const, tx_hash: null };

const FORBIDDEN = /\b(we|our|us|never|always|only|every|daily|guarantee|certified|verified by|trust)\b/i;
/** 依頼主承認: l2_conform_no_required_keys の "checked only that" のみ断定語 only を許容。 */
const FORBIDDEN_REASON_TEXT_EXCEPTIONS: Readonly<Record<string, string>> = {
  l2_conform_no_required_keys: "checked only that",
};
const ASSERTION_LAYOUT = /[;\u2013\u2014]| - /;
const OPENAPI_DOC_FORBIDDEN = /\b(we|our|us|never|always|only|every|guarantee)\b|[;\u2013\u2014]| - /i;

const BUYER_BASE: BuyerFacts = {
  settled_count_30d: 12,
  unique_payees_30d: 4,
  short_interval_payment_rate: 0.05,
  retry_burst_rate: 0.05,
  sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
  erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
  first_seen: "2026-07-01T00:00:00Z",
  last_seen: "2026-09-01T00:00:00Z",
};

function buildPayee(
  over: Partial<BuyerFacts> = {},
  operatorBlacklist = false,
): DecisionResult {
  const facts: BuyerFacts = {
    ...BUYER_BASE,
    ...over,
    sybil: { ...BUYER_BASE.sybil, ...over.sybil },
    erc8004: { ...BUYER_BASE.erc8004, ...over.erc8004 },
  };
  return buildDecision({
    role: "payee",
    subject: SUBJECT,
    payer: "eip155:8453:0x" + "9".repeat(40),
    facts,
    operatorBlacklist,
    registry,
    spendingHalted: false,
    now: NOW,
  });
}

function buildPayer(
  over: Partial<SellerFacts> = {},
  options: PayerOptions = {},
  verifiedTerms: VerifiedTerms | null = null,
): DecisionResult {
  return buildDecision({
    role: "payer",
    subject: SUBJECT,
    facts: { ...SELLER_BASE, ...over, l1: { ...SELLER_BASE.l1, ...over.l1 }, l2: over.l2 ?? SELLER_BASE.l2 },
    options: { now: NOW, ...options },
    score: null,
    registry,
    verifiedTerms,
    l2PurchaseId: "eip155:8453:0x" + "b".repeat(64),
  });
}

test("全 reason_code に英語1文がある（1つ欠けたら落ちる）", () => {
  const tableKeys = new Set(REASON_CODES.map((r) => r.code));
  const textKeys = new Set(Object.keys(REASON_TEXT));
  assert.deepEqual([...textKeys].sort(), [...tableKeys].sort());
  for (const code of tableKeys) assert.equal(typeof REASON_TEXT[code], "string");
});

test("rules.ts が出しうる語は全部 reasonTextOf と効き目を持つ", () => {
  const seen = new Set<string>();
  const l0s = ["pass", "fail", "unverified"] as const;
  const causes = [null, "single_fail", "tls", "not_probed", "no_recent_probe", "request_shape"];
  const l1s: Partial<SellerFacts["l1"]>[] = [
    { n_attempts: 0, n_delivered: 0, n_settled: 0 },
    { n_attempts: 3, n_delivered: 0, n_settled: 0 },
    { n_attempts: 3, n_delivered: 0, n_settled: 3 },
    { n_attempts: 3, n_delivered: 1, n_settled: 1 },
  ];
  const l2s: SellerFacts["l2"][] = [
    SELLER_BASE.l2,
    { ...SELLER_BASE.l2, status: "conform" },
    { ...SELLER_BASE.l2, status: "mismatch", missing_keys: [] },
    { ...SELLER_BASE.l2, status: "mismatch", missing_keys: ["a"] },
    { ...SELLER_BASE.l2, status: "not_checked" },
    { ...SELLER_BASE.l2, status: "undeclared" },
  ];
  const nc = [undefined, { total: 3, by: { vet402_side: 1, held: 1, no_charge: 1, unproven: 1, unconfirmed: 1, settlement_unknown: 1 } }];
  for (const l0 of l0s)
    for (const cause of causes)
      for (const l1 of l1s)
        for (const l2v of l2s)
          for (const notCounted of nc)
            for (const extra of [
              {},
              { allowWithoutL1: true, operatorBlacklist: true, dataDepth: "thin" as const, callerDialect: "v1" as const },
              {
                l1Timeline: {
                  n_counted: 2,
                  n_paid_undelivered: 1,
                  n_paid_undelivered_since_delivery: 1,
                  latest_counted: { at: daysAgo(1), delivered: false },
                  last_delivered_at: daysAgo(40),
                  last_signed_attempt_at: daysAgo(40),
                },
              },
              {
                l1Timeline: {
                  n_counted: 2,
                  n_paid_undelivered: 2,
                  n_paid_undelivered_since_delivery: 2,
                  n_paid_undelivered_seller_side_since_delivery: 2,
                  latest_counted: { at: daysAgo(1), delivered: false },
                  last_delivered_at: null,
                  last_signed_attempt_at: daysAgo(1),
                },
              },
            ]) {
              const f: SellerFacts = {
                ...SELLER_BASE,
                l0: { ...SELLER_BASE.l0, status: l0 },
                l1: { ...SELLER_BASE.l1, ...l1 },
                l2: l2v,
                offer_stability: "drifting",
                wash_dominated: true,
              };
              const d = decidePayer(f, { l0UnverifiedCause: cause, l1NotCounted: notCounted, now: NOW, ...extra });
              for (const c of d.reason_codes) seen.add(c);
              const stale = decidePayer(
                { ...f, l1: { ...f.l1, n_attempts: 0, n_delivered: 0 } },
                {
                  l1Timeline: {
                    n_counted: 0,
                    n_paid_undelivered: 0,
                    n_paid_undelivered_since_delivery: 0,
                    latest_counted: null,
                    last_delivered_at: null,
                    last_signed_attempt_at: daysAgo(40),
                  },
                  now: NOW,
                },
              );
              for (const c of stale.reason_codes) seen.add(c);
            }
  for (const c of decidePayer(
    { ...SELLER_BASE, l2: { ...SELLER_BASE.l2, status: "conform" } },
    { l2ConformNoRequiredKeys: true, now: NOW },
  ).reason_codes)
    seen.add(c);

  for (const v of [
    BUYER_BASE,
    { ...BUYER_BASE, erc8004: { agent_id: "1", feedback_with_payment_proof_ratio: null } },
    { ...BUYER_BASE, settled_count_30d: 1, first_seen: daysAgo(1), sybil: { ...BUYER_BASE.sybil, shared_funder: true } },
    {
      ...BUYER_BASE,
      sybil: { multi_agent_owner: true, shared_funder: true, cluster_id: "c", unavailable: ["settlements", "funder_index", "erc8004"] },
    },
  ])
    for (const bl of [false, true])
      for (const c of decidePayee(v, { now: NOW, operatorBlacklist: bl }).reason_codes) seen.add(c);

  for (const code of seen) {
    assert.ok(reasonCodeDocOf(code), code);
    const explained = explainReasons({
      codes: [code],
      role: reasonCodeDocOf(code)!.role === "payee" ? "payee" : "payer",
      basis: null,
      observatoryId: SUBJECT.observatory_id,
      verifiedTerms: null,
      l2: SELLER_BASE.l2,
      l2PurchaseId: null,
    })[0];
    assert.ok(reasonTextOf(code), code);
    assert.doesNotMatch(explained.text, /no sentence for this reason code yet/);
    assert.ok(["sets_block", "caps_at_warn", "none"].includes(explained.effect));
  }
});

test("文の決まり", () => {
  for (const [code, text] of Object.entries(REASON_TEXT)) {
    const exc = FORBIDDEN_REASON_TEXT_EXCEPTIONS[code];
    if (exc) {
      const probe = text.replace(exc, exc.replace(/\bonly\b/i, "___"));
      assert.doesNotMatch(probe, FORBIDDEN, text);
    } else {
      assert.doesNotMatch(text, FORBIDDEN, text);
    }
    assert.doesNotMatch(text, ASSERTION_LAYOUT, text);
    assert.doesNotMatch(text, /\. /);
    assert.equal((text.match(/\./g) ?? []).length, 1);
    assert.ok(text.endsWith("."));
  }
});

test("効き目が判定と食い違わない", () => {
  const combos: Array<{ rec: string; codes: string[]; role: "payer" | "payee"; basis: ReturnType<typeof buildPayer>["l1_basis"] }> = [];
  const seen = new Set<string>();
  const push = (d: { recommendation: string; reason_codes: string[] }, role: "payer" | "payee", basis: typeof combos[0]["basis"]) => {
    const key = `${role}:${d.recommendation}:${d.reason_codes.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    combos.push({ rec: d.recommendation, codes: d.reason_codes, role, basis });
  };
  const l0s = ["pass", "fail", "unverified"] as const;
  for (const l0 of l0s) {
    const f: SellerFacts = { ...SELLER_BASE, l0: { ...SELLER_BASE.l0, status: l0 }, wash_dominated: l0 === "pass" ? false : true };
    const d = decidePayer(f, { now: NOW });
    push(d, "payer", null);
  }
  const stale40 = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(41), delivered: true },
        last_delivered_at: daysAgo(40),
        last_signed_attempt_at: daysAgo(40),
      },
    },
  );
  push({ recommendation: stale40.recommendation, reason_codes: stale40.reason_codes }, "payer", stale40.l1_basis);
  for (const c of combos) {
    const reasons = explainReasons({
      codes: c.codes,
      role: c.role,
      basis: c.basis,
      observatoryId: SUBJECT.observatory_id,
      verifiedTerms: null,
      l2: SELLER_BASE.l2,
      l2PurchaseId: null,
    });
    const blocks = reasons.filter((r) => r.effect === "sets_block").length;
    const caps = reasons.filter((r) => r.effect === "caps_at_warn").length;
    if (c.rec === "BLOCK") assert.ok(blocks >= 1);
    else if (c.rec === "WARN") {
      assert.equal(blocks, 0);
      assert.ok(caps >= 1);
    } else {
      assert.equal(blocks, 0);
      assert.equal(caps, 0);
    }
  }
});

test("40 日前の払った試験だけ（最後の配達が 40 日前）の endpoint は ALLOW にならない", () => {
  const d = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(41), delivered: true },
        last_delivered_at: daysAgo(40),
        last_signed_attempt_at: daysAgo(40),
      },
    },
  );
  assert.equal(d.recommendation, "WARN");
  assert.equal(d.evidence_age?.tier, "stale");
  assert.equal(d.evidence_age?.max_recommendation, "WARN");
  assert.equal(Object.keys(d)[0], "evidence_age");
  assert.match(d.evidence_age?.text ?? "", /2026-/);
  assert.match(d.evidence_age?.text ?? "", /40/);
});

test("3 日前なら上限なし", () => {
  const d = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(4), delivered: true },
        last_delivered_at: daysAgo(3),
        last_signed_attempt_at: daysAgo(3),
      },
    },
  );
  assert.equal(d.recommendation, "ALLOW");
  assert.equal(d.evidence_age?.tier, "fresh");
  assert.equal(d.evidence_age?.max_recommendation, "ALLOW");
});

test("8〜30 日は aging・判定は変えない", () => {
  const d20 = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(21), delivered: true },
        last_delivered_at: daysAgo(20),
        last_signed_attempt_at: daysAgo(20),
      },
    },
  );
  assert.equal(d20.recommendation, "ALLOW");
  assert.equal(d20.evidence_age?.tier, "aging");
  assert.ok(!d20.reason_codes.includes("l1_stale"));

  const d31 = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(32), delivered: true },
        last_delivered_at: daysAgo(31),
        last_signed_attempt_at: daysAgo(31),
      },
    },
  );
  assert.equal(d31.recommendation, "WARN");
  assert.ok(d31.reason_codes.includes("l1_stale"));
  assert.equal(d31.evidence_age?.tier, "stale");
});

test("30.04 日前の窓の外の配達（窓の中の配達 0）で答えが WARN なら evidence_age は stale・上限 WARN", () => {
  const d = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 2, n_settled: 2 } },
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(2), delivered: false },
        last_delivered_at: daysAgo(30.04),
        last_signed_attempt_at: daysAgo(2),
      },
    },
  );
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_stale"));
  assert.equal(d.evidence_age?.tier, "stale");
  assert.equal(d.evidence_age?.max_recommendation, "WARN");
});

test("evidence_age.max_recommendation が判定の L1 古さ・免除と一致する（窓内配達あり／窓外のみ）", () => {
  const ages = [6.9, 7, 7.1, 29.9, 30, 30.04, 30.05, 30.1, 31, 40] as const;
  for (const age of ages) {
    const inWindow = buildPayer(
      {},
      {
        l1Timeline: {
          n_counted: 1,
          n_paid_undelivered: 0,
          n_paid_undelivered_since_delivery: 0,
          latest_counted: { at: daysAgo(age + 1), delivered: true },
          last_delivered_at: daysAgo(age),
          last_signed_attempt_at: daysAgo(age),
        },
      },
    );
    const staleL1 = inWindow.reason_codes.includes("l1_stale");
    const waived = inWindow.reason_codes.includes("l1_waived_by_operator");
    const expectWarnCap =
      (staleL1 && !waived) ||
      inWindow.evidence_age?.tier === "none" ||
      inWindow.recommendation === "WARN";
    if (inWindow.evidence_age?.tier === "fresh" || inWindow.evidence_age?.tier === "aging") {
      assert.equal(inWindow.evidence_age.max_recommendation, "ALLOW", `in-window age ${age}`);
    } else {
      assert.equal(
        inWindow.evidence_age?.max_recommendation === "WARN",
        expectWarnCap && !waived,
        `in-window age ${age} stale=${staleL1}`,
      );
    }
    if (inWindow.evidence_age?.max_recommendation === "ALLOW" && inWindow.recommendation === "WARN") {
      assert.ok(
        inWindow.reason_codes.some((c) => c !== "l1_stale" && !c.startsWith("l1_not_counted")),
        `ALLOW cap but WARN answer must not be L1 staleness alone: age ${age}`,
      );
    }
  }
  const outsideOnly = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 1 } },
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(1), delivered: false },
        last_delivered_at: daysAgo(30.04),
        last_signed_attempt_at: daysAgo(1),
      },
    },
  );
  assert.ok(outsideOnly.reason_codes.includes("l1_stale"));
  assert.equal(outsideOnly.evidence_age?.tier, "stale");
  assert.equal(outsideOnly.evidence_age?.max_recommendation, "WARN");
});

test("allow_without_l1 で配達 0・数えた失敗ありのとき、答えが WARN なら evidence_age の上限も WARN", () => {
  const warn = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 2, n_settled: 2 } },
    {
      allowWithoutL1: true,
      l1Timeline: {
        n_counted: 2,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(1), delivered: false },
        last_delivered_at: null,
        last_signed_attempt_at: daysAgo(1),
      },
    },
  );
  assert.equal(warn.recommendation, "WARN");
  assert.ok(!warn.reason_codes.includes("l1_waived_by_operator"));
  assert.equal(warn.evidence_age?.max_recommendation, "WARN");
  assert.equal(warn.evidence_age?.waived_by_caller, false);

  const allow = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 0 } },
    { allowWithoutL1: true },
  );
  assert.ok(allow.reason_codes.includes("l1_waived_by_operator"));
  assert.equal(allow.evidence_age?.waived_by_caller, true);
  assert.equal(allow.evidence_age?.max_recommendation, "ALLOW");
});

test("l1_waived_by_operator が付いているときだけ stale/none の上限を外す（waived_by_caller）", () => {
  const stale = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 0, n_settled: 0 } },
    { allowWithoutL1: true, l1Timeline: { n_counted: 0, n_paid_undelivered: 0, n_paid_undelivered_since_delivery: 0, latest_counted: null, last_delivered_at: daysAgo(40), last_signed_attempt_at: daysAgo(40) } },
  );
  assert.ok(stale.reason_codes.includes("l1_waived_by_operator"));
  assert.equal(stale.evidence_age?.waived_by_caller, true);
  assert.equal(stale.evidence_age?.max_recommendation, "ALLOW");

  const none = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 0, n_settled: 0 } },
    { allowWithoutL1: true },
  );
  assert.equal(none.evidence_age?.tier, "none");
  assert.equal(none.evidence_age?.waived_by_caller, true);
});

test("根拠の無い理由に偽の tx を付けない", () => {
  const paidUndelivered = buildPayer(
    {
      l1: { ...SELLER_BASE.l1, n_delivered: 1, last_purchase_id: "eip155:8453:0x" + "c".repeat(64) },
      l2: { ...SELLER_BASE.l2, status: "mismatch" as const, missing_keys: ["x"] },
    },
    {
      l1Timeline: {
        n_counted: 2,
        n_paid_undelivered: 1,
        n_paid_undelivered_since_delivery: 1,
        latest_counted: { at: daysAgo(1), delivered: false },
        last_delivered_at: daysAgo(5),
        last_signed_attempt_at: daysAgo(1),
      },
    },
    null,
  );
  for (const code of ["l1_paid_not_delivered", "l1_latest_failed"] as const) {
    const row = paidUndelivered.reasons.find((r) => r.code === code);
    assert.ok(row);
    assert.ok(!row.evidence.some((e) => e.kind === "tx" || e.kind === "purchase"));
  }
  const noAttempt = buildPayer(
    { l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 0 }, l2: { ...SELLER_BASE.l2, status: "undeclared" } },
    { operatorBlacklist: true },
  );
  for (const code of ["l1_not_attempted", "operator_blacklist", "l2_undeclared"] as const) {
    const row = noAttempt.reasons.find((r) => r.code === code);
    assert.ok(row, code);
    assert.equal(row.evidence_status, "none");
    assert.deepEqual(row.evidence, []);
  }
});

test("配達の根拠は本物の purchase_id から作る", () => {
  const tx = "a".repeat(64);
  const purchaseId = `eip155:8453:0x${tx}`;
  const vt: VerifiedTerms = {
    purchase_id: purchaseId,
    pay_to: "0x" + "1".repeat(40),
    asset: "0x" + "2".repeat(40),
    amount: "1000",
    decimals: 6,
    network: "eip155:8453",
    scheme: "exact",
    protocol: "x402",
    verified_at: daysAgo(3),
  };
  const d = buildPayer({}, { l1Timeline: { n_counted: 1, n_paid_undelivered: 0, n_paid_undelivered_since_delivery: 0, latest_counted: { at: daysAgo(4), delivered: true }, last_delivered_at: daysAgo(3), last_signed_attempt_at: daysAgo(3) } }, vt);
  const del = d.reasons.find((r) => r.code === "l1_delivered");
  assert.ok(del);
  const purchase = del.evidence.find((e) => e.kind === "purchase");
  const txRef = del.evidence.find((e) => e.kind === "tx");
  assert.equal(purchase?.id, purchaseId);
  assert.equal(txRef?.id, `0x${tx}`);
  assert.match(txRef?.url ?? "", /basescan\.org/);

  const l2 = d.reasons.find((r) => r.code === "l2_conform");
  assert.ok(l2?.evidence.some((e) => e.kind === "response_hash" && e.id === SELLER_BASE.l2.response_hash));
});

test("互換: 既存の欄が残る", async () => {
  const d = buildPayer();
  const keys = [
    "subject",
    "role",
    "payer",
    "recommendation",
    "reason_codes",
    "facts",
    "spending_halted",
    "not_attempted_reason",
    "freshness",
    "l1_basis",
    "verified_terms",
    "evidence",
    "degraded",
    "policy",
    "rules_version",
    "registry",
    "scoredAt",
    "cacheExpiresAt",
    "disclaimer",
  ] as const;
  for (const k of keys) assert.ok(k in d, k);

  const decision = buildPayer({}, { l1Timeline: { n_counted: 1, n_paid_undelivered: 0, n_paid_undelivered_since_delivery: 0, latest_counted: { at: daysAgo(4), delivered: true }, last_delivered_at: daysAgo(3), last_signed_attempt_at: daysAgo(3) } });
  const deps = {
    now: () => NOW,
    resolve: async () => ({
      resource: { observatory_id: SUBJECT.observatory_id, canonical_url: SUBJECT.canonical_url, method: "GET" },
      endpoints: [],
    }),
    decide: async () => decision,
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}),
  } as unknown as McpDeps;
  const out = await checkSeller(deps, { url: SUBJECT.canonical_url });
  checkSellerOutput.parse(out);
  assert.equal(Object.keys(out)[0], "evidence_age");
  assert.ok(Array.isArray(out.reasons));
});

test("evidenceAgeOf は7日以内を fresh にする", () => {
  const basis = {
    window_days: 30,
    fresh_days: 30,
    n_counted: 1,
    n_not_counted: 0,
    n_paid_undelivered: 0,
    n_paid_undelivered_since_last_delivery: 0,
    n_paid_undelivered_seller_side_since_last_delivery: 0,
    latest_counted_delivered: true,
    last_attempt_at: daysAgo(3),
    last_signed_attempt_at: daysAgo(3),
    last_delivered_at: daysAgo(3),
    days_since_last_attempt: 3,
    days_since_last_delivery: 3,
  };
  const age = evidenceAgeOf(basis, { reason_codes: ["l0_pass", "l1_delivered"] });
  assert.equal(age.tier, "fresh");
  assert.equal(age.fresh_within_days, 7);
  assert.equal(age.stale_after_days, 30);
});

test("オプトイン無しで配達が無い（tier none）とき recommendation が ALLOW にならず max_recommendation が WARN", () => {
  const d = buildPayer({ l1: { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 0, n_settled: 0 } }, {});
  assert.notEqual(d.recommendation, "ALLOW");
  assert.equal(d.evidence_age?.tier, "none");
  assert.equal(d.evidence_age?.max_recommendation, "WARN");
});

test("l1_waived_by_operator 付き stale は text に WARN を含めない（waived_by_caller）・オプトイン無し stale は WARN を含める", () => {
  const timeline = {
    n_counted: 0,
    n_paid_undelivered: 0,
    n_paid_undelivered_since_delivery: 0,
    latest_counted: null,
    last_delivered_at: daysAgo(40),
    last_signed_attempt_at: daysAgo(40),
  };
  const l1 = { ...SELLER_BASE.l1, n_delivered: 0, n_attempts: 0, n_settled: 0 };
  const waived = buildPayer({ l1 }, { allowWithoutL1: true, l1Timeline: timeline });
  assert.ok(waived.reason_codes.includes("l1_waived_by_operator"));
  assert.equal(waived.evidence_age?.waived_by_caller, true);
  assert.doesNotMatch(waived.evidence_age?.text ?? "", /WARN/);

  const plain = buildPayer({ l1 }, { l1Timeline: timeline });
  assert.equal(plain.evidence_age?.waived_by_caller, false);
  assert.match(plain.evidence_age?.text ?? "", /WARN/);
});

test("30.1 日の stale の text に 30.1 が含まれる", () => {
  const d = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(30.2), delivered: true },
        last_delivered_at: daysAgo(30.1),
        last_signed_attempt_at: daysAgo(30.1),
      },
    },
  );
  assert.ok(d.reason_codes.includes("l1_stale"));
  assert.equal(d.evidence_age?.tier, "stale");
  assert.match(d.evidence_age?.text ?? "", /30\.1/);
});

test("l1_delivered・l1_stale の根拠は規則が見た最後の配達と同じ購入だけ（窓の外の購入を指さない）", () => {
  const purchasesUrl = `https://vet402.com/api/v1/observatory/endpoints/${SUBJECT.observatory_id}/purchases`;
  const tx = "a".repeat(64);
  const purchaseId = `eip155:8453:0x${tx}`;
  const vtMismatch: VerifiedTerms = {
    purchase_id: purchaseId,
    pay_to: "0x" + "1".repeat(40),
    asset: "0x" + "2".repeat(40),
    amount: "1000",
    decimals: 6,
    network: "eip155:8453",
    scheme: "exact",
    protocol: "x402",
    verified_at: daysAgo(45),
  };
  const dMismatch = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(4), delivered: true },
        last_delivered_at: daysAgo(3),
        last_signed_attempt_at: daysAgo(3),
      },
    },
    vtMismatch,
  );
  const del = dMismatch.reasons.find((r) => r.code === "l1_delivered");
  assert.ok(del);
  assert.ok(!del.evidence.some((e) => e.kind === "purchase" || e.kind === "tx"));
  assert.deepEqual(del.evidence, [{ kind: "record", id: null, url: purchasesUrl }]);
  assert.equal(del.evidence_status, "record");

  const at = daysAgo(3);
  const vtMatch: VerifiedTerms = { ...vtMismatch, verified_at: at };
  const dMatch = buildPayer(
    {},
    {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(4), delivered: true },
        last_delivered_at: at,
        last_signed_attempt_at: at,
      },
    },
    vtMatch,
  );
  const del2 = dMatch.reasons.find((r) => r.code === "l1_delivered");
  assert.ok(del2?.evidence.some((e) => e.kind === "purchase" && e.id === purchaseId));
  assert.ok(del2?.evidence.some((e) => e.kind === "tx"));
});

test("MCP の出力予算を超えるとき reasons から削り reason_codes は残る", async () => {
  const pad = "x".repeat(1000);
  const base = buildPayer(
    {
      l0: { ...SELLER_BASE.l0, status: "unverified" as const },
      l2: { ...SELLER_BASE.l2, status: "mismatch" as const, missing_keys: ["a"] },
      offer_stability: "drifting" as const,
      wash_dominated: true,
    },
    { operatorBlacklist: true, dataDepth: "thin", callerDialect: "v1", l0UnverifiedCause: "tls" },
  );
  const codes = Array.from({ length: 9 }, (_, i) => base.reason_codes[i] ?? `l1_not_counted_held`);
  assert.equal(codes.length, 9);
  const reasonByCode = new Map(base.reasons.map((r) => [r.code, r]));
  const reasons = codes.map((code) => {
    const r = reasonByCode.get(code);
    return r
      ? { ...r, text: `${pad} ${code}` }
      : {
          code,
          text: `${pad} ${code}`,
          effect: "none" as const,
          max_recommendation: "ALLOW" as const,
          evidence_status: "none" as const,
          evidence: [],
        };
  });
  const decision: DecisionResult = { ...base, reason_codes: codes, reasons };
  const deps = {
    now: () => NOW,
    resolve: async () => ({
      resource: { observatory_id: SUBJECT.observatory_id, canonical_url: SUBJECT.canonical_url, method: "GET" },
      endpoints: [],
    }),
    decide: async () => decision,
    l1Purchases: async () =>
      Array.from({ length: 20 }, (_, i) => ({
        attempted_at: daysAgo(i),
        network: "eip155:8453",
        status: "settled",
        tx_hash: "0x" + i.toString(16).padStart(64, "0"),
        explorer_url: "https://example.com",
      })),
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}),
  } as unknown as McpDeps;
  const out = await checkSeller(deps, { url: SUBJECT.canonical_url });
  assert.equal(out.reason_codes.length, codes.length);
  assert.ok(out.reasons.length < codes.length);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(out), "utf8") <= MAX_STRUCTURED_BYTES);
});

const APPROVED_REASON_TEXT_PATCH: Readonly<Record<string, string>> = {
  "l0_unverified_<cause>":
    "vet402 could not measure a valid HTTP 402 from this URL, and the code names the cause such as not_probed, tls or path_template.",
  l0_unverified:
    "vet402 has not measured a valid HTTP 402 recently, and a companion code names why when vet402 recorded one.",
  l1_empty_2xx_settlement_unknown:
    "After the last delivery, or in the window when there was none, a paid attempt brought nothing back and it is not yet known whether money moved.",
  l1_paid_not_delivered:
    "After the last delivery in the window, or in the window when there was none, a payment moved on chain and no delivery came back.",
  l2_conform_no_required_keys:
    "The latest delivered body matched a declaration that marks no key as required, so vet402 checked only that the body is a JSON object or array.",
  l2_not_checked:
    "An output declaration exists for this URL but vet402 has not checked a delivered body against it.",
  l2_mismatch: "The latest delivered body did not match the output declaration for this URL.",
  l2_conform: "The latest delivered body has the keys the output declaration for this URL requires.",
  wash_dominated:
    "Real payments are 10 percent or less of at least 10 settlements to this seller from payers other than vet402 and listed measurement services in the 30 day window.",
};

test("REASON_TEXT に依頼主指定の 9 文が完全一致で入っている", () => {
  for (const [code, expected] of Object.entries(APPROVED_REASON_TEXT_PATCH)) {
    assert.equal(REASON_TEXT[code], expected, code);
  }
});

test("role=payee の reasons は効き目どおりで evidence は空", () => {
  const expect = (
    d: DecisionResult,
    code: string,
    effect: "sets_block" | "caps_at_warn" | "none",
  ) => {
    const row = d.reasons.find((r) => r.code === code);
    assert.ok(row, code);
    assert.equal(row.effect, effect, code);
    assert.deepEqual(row.evidence, [], code);
    assert.equal(row.evidence_status, "none", code);
  };

  expect(buildPayee({}, true), "operator_blacklist", "sets_block");
  expect(
    buildPayee({
      sybil: { multi_agent_owner: true, shared_funder: true, cluster_id: "c", unavailable: [] },
    }),
    "sybil_high",
    "sets_block",
  );
  expect(
    buildPayee({
      sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: ["settlements"] },
    }),
    "settlements_unavailable",
    "sets_block",
  );
  expect(buildPayee({ settled_count_30d: 1 }), "thin_history", "caps_at_warn");
  expect(buildPayee({ sybil: { multi_agent_owner: false, shared_funder: true, cluster_id: null, unavailable: [] } }), "shared_funder", "caps_at_warn");
  expect(buildPayee({ first_seen: daysAgo(1) }), "new_payer", "caps_at_warn");
  expect(buildPayee({}), "history_ok", "none");
  expect(buildPayee({ erc8004: { agent_id: "1", feedback_with_payment_proof_ratio: null } }), "erc8004_registered", "none");
});

function openapiSchemaBlockEnd(yaml: string, start: number): number {
  const tail = yaml.slice(start + 1);
  const m = /^\n    [A-Za-z][A-Za-z0-9_]*:\n/m.exec(tail);
  return m ? start + 1 + m.index! : yaml.length;
}

function descriptionsFromBlock(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split("\n")) {
    const inline = /^\s+description:\s+(.+)$/.exec(line);
    if (inline) out.push(inline[1].replace(/^"|"$/g, ""));
  }
  return out;
}

function assertOpenApiDescription(desc: string, label: string) {
  assert.doesNotMatch(desc, OPENAPI_DOC_FORBIDDEN, label);
  assert.doesNotMatch(desc, /\.\s+\S/, `${label} (複文)`);
  assert.equal((desc.match(/\./g) ?? []).length, 1, label);
  assert.ok(desc.endsWith("."), label);
}

test("openapi の EvidenceAge・ReasonExplanation・ReasonEvidenceRef と DecisionResult の description 文体", () => {
  const yaml = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
  for (const name of ["ReasonEvidenceRef", "ReasonExplanation", "EvidenceAge"] as const) {
    const start = yaml.indexOf(`    ${name}:\n`);
    assert.ok(start >= 0, name);
    const block = yaml.slice(start, openapiSchemaBlockEnd(yaml, start));
    for (const desc of descriptionsFromBlock(block)) assertOpenApiDescription(desc, name);
  }
  const drStart = yaml.indexOf("    DecisionResult:\n");
  const drBlock = yaml.slice(drStart, openapiSchemaBlockEnd(yaml, drStart));
  for (const prop of ["evidence_age", "reasons"] as const) {
    const idx = drBlock.indexOf(`        ${prop}:`);
    const sub = drBlock.slice(idx, idx + 600);
    const dm = /\n          description:\s+(.+)/.exec(sub);
    assert.ok(dm, prop);
    assertOpenApiDescription(dm![1].trim(), `DecisionResult.${prop}`);
  }
});

test("L2 を決めた購入が無い（l2PurchaseId: null）とき、last_purchase_id の tx を L2 の理由に付けない", () => {
  const failedTx = "eip155:8453:0x" + "c".repeat(64);
  const d = buildDecision({
    role: "payer",
    subject: SUBJECT,
    facts: { ...SELLER_BASE, l1: { ...SELLER_BASE.l1, last_purchase_id: failedTx }, l2: { ...SELLER_BASE.l2, status: "conform" } },
    options: { now: NOW },
    score: null,
    registry,
    verifiedTerms: null,
    l2PurchaseId: null,
  });
  const l2 = d.reasons.filter((r) => r.code.startsWith("l2_"));
  assert.ok(l2.length >= 1);
  for (const r of l2) {
    assert.ok(!r.evidence.some((e) => e.kind === "tx" || e.kind === "purchase"), `${r.code} に購入か tx が付いた`);
    assert.ok(!JSON.stringify(r.evidence).includes("c".repeat(64)));
  }
});

test("l1_waived_by_operator は l1_not_attempted・l1_stale・l1_inconclusive の効き目だけを none にし、払ったのに届かないは caps_at_warn のまま", () => {
  const rest = ["l0_pass", "l1_not_attempted", "l1_stale", "l1_inconclusive", "l1_paid_not_delivered"];
  const base = { role: "payer" as const, basis: null, observatoryId: SUBJECT.observatory_id, verifiedTerms: null, l2: null, l2PurchaseId: null };
  const byCode = (waived: boolean) =>
    Object.fromEntries(
      explainReasons({
        ...base,
        codes: waived ? [...rest, "l1_waived_by_operator"] : rest,
      }).map((r) => [r.code, r.effect]),
    );
  const off = byCode(false);
  const on = byCode(true);
  for (const c of ["l1_not_attempted", "l1_stale", "l1_inconclusive"]) {
    assert.equal(off[c], "caps_at_warn", c);
    assert.equal(on[c], "none", c);
  }
  assert.equal(off.l1_paid_not_delivered, on.l1_paid_not_delivered);
  assert.notEqual(on.l1_paid_not_delivered, "none");
});

test("l1_stale の根拠も規則が見た最後の配達と同じ購入だけ（一致すれば購入と tx、しなければ購入の一覧）", () => {
  const purchasesUrl = `https://vet402.com/api/v1/observatory/endpoints/${SUBJECT.observatory_id}/purchases`;
  const purchaseId = `eip155:8453:0x${"d".repeat(64)}`;
  const at = daysAgo(40);
  const vt: VerifiedTerms = {
    purchase_id: purchaseId,
    pay_to: "0x" + "1".repeat(40),
    asset: "0x" + "2".repeat(40),
    amount: "1000",
    decimals: 6,
    network: "eip155:8453",
    scheme: "exact",
    protocol: "x402",
    verified_at: at,
  };
  const timeline = {
    n_counted: 1,
    n_paid_undelivered: 0,
    n_paid_undelivered_since_delivery: 0,
    latest_counted: { at, delivered: true },
    last_delivered_at: at,
    last_signed_attempt_at: at,
  };
  const match = buildPayer({}, { l1Timeline: timeline }, vt).reasons.find((r) => r.code === "l1_stale");
  assert.ok(match, "l1_stale が出ていない");
  assert.ok(match.evidence.some((e) => e.kind === "purchase" && e.id === purchaseId));
  assert.ok(match.evidence.some((e) => e.kind === "tx" && e.id === "0x" + "d".repeat(64)));
  const other = buildPayer({}, { l1Timeline: timeline }, { ...vt, verified_at: daysAgo(50) }).reasons.find((r) => r.code === "l1_stale");
  assert.ok(other);
  assert.deepEqual(other.evidence, [{ kind: "record", id: null, url: purchasesUrl }]);
});

test("窓の中の配達 30.05 日前（丸めると 30.1）: evidence_age の stale は l1_stale の有無と必ず一致する", () => {
  for (const age of [30, 30.04, 30.05, 30.06]) {
    const d = buildPayer({}, {
      l1Timeline: {
        n_counted: 1,
        n_paid_undelivered: 0,
        n_paid_undelivered_since_delivery: 0,
        latest_counted: { at: daysAgo(age), delivered: true },
        last_delivered_at: daysAgo(age),
        last_signed_attempt_at: daysAgo(age),
      },
    });
    const staleCode = d.reason_codes.includes("l1_stale");
    assert.equal(d.evidence_age?.tier === "stale", staleCode, `age ${age}: ${d.evidence_age?.tier} / ${d.reason_codes.join(",")}`);
    assert.equal(d.evidence_age?.max_recommendation === "WARN", staleCode, `age ${age}`);
    if (!staleCode) assert.equal(d.recommendation, "ALLOW", `age ${age}`);
    else assert.notEqual(d.recommendation, "ALLOW", `age ${age}`);
  }
});

test("reason-codes.ts の meaning 3つは「output declaration for this URL」の言い方", () => {
  const m = (c: string) => REASON_CODES.find((r) => r.code === c)?.meaning;
  assert.equal(m("l2_mismatch"), "The latest delivered body did not match the output declaration for this URL.");
  assert.equal(m("l2_conform"), "The latest delivered body has the keys the output declaration for this URL requires.");
  assert.match(m("l2_not_checked") ?? "", /^An output declaration exists for this URL, but vet402 has not checked a delivered body against it: /);
  for (const r of REASON_CODES) assert.doesNotMatch(r.meaning, /listing's output schema/, r.code);
});
