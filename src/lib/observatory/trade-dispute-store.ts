// ============================================================
// P2 争いの端の保存（memory + Postgres）。
// ============================================================
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { utcDayStartOf } from "@/lib/db/utc-day";
import { shiftDay } from "@/lib/observatory/metrics-rollup";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { tradeDisputeDayRoots, tradeDisputeLegs } from "@/lib/db/schema";
import { rowsOf } from "@/lib/settlements/upsert";
import { recomputeTradeDisputeDayRoot, type SealTradeDisputeDayResult } from "@/lib/observatory/e6-anchors";
import { buildPublicClaimsJsonWithChain } from "@/lib/observatory/trade-dispute-judge";
import {
  countLegsForTradeSide,
  countWritesForLimit,
  signingWalletForLeg,
  tradeSideHistoryLimitExceeded,
  utcDayOfIso,
  writeLimitPerTradeSide,
  writeLimitPerWallet,
} from "@/lib/observatory/trade-dispute-write-limits";
import { getE6ChainReader } from "@/lib/observatory/e6-chain-reader";

const PUBLIC_READ_CHAIN = "eip155:84532";

export type TradeDisputeLegRow = {
  tradeId: string;
  side: "payer" | "seller";
  chain: string;
  payer: string;
  receiver: string;
  paymentInfoOperator: string;
  signer: string;
  paymentTx: string;
  delivery: string;
  receivedBodySha256: string | null;
  paymentSeen: string | null;
  deliveredBodySha256: string | null;
  sellerReceiptCommitment: string | null;
  sellerReceiptSignature: string | null;
  sellerReceiptIssued: string | null;
  commitment: string;
  issued: string;
  acceptedAt: string;
  /** Postgres 行の id。メモリ実装では無い。current の tie-break に使う。 */
  id?: number;
};

export type TradeDisputeLegsSide = {
  current: TradeDisputeLegRow | null;
  history: TradeDisputeLegRow[];
};

export type TradeDisputeDaySeal = {
  rootHash: string;
  prevRoot: string | null;
  entryCount: number;
  payload: string;
};

export type TradeDisputeDayAnchors = {
  payer: { day: string; commitment: string } | null;
  seller: { day: string; commitment: string } | null;
};

export type TradeDisputeStore = {
  getLegs(tradeId: string): Promise<{ payer: TradeDisputeLegsSide; seller: TradeDisputeLegsSide }>;
  countWrites(wallet: string, utcDay: string): Promise<number>;
  countLegsForSide(tradeId: string, side: "payer" | "seller"): Promise<number>;
  insertLeg(row: TradeDisputeLegRow): Promise<void>;
  listAllLegs(): Promise<TradeDisputeLegRow[]>;
  listByReceiver(receiver: string, limit: number): Promise<TradeDisputeLegRow[]>;
  listLegsForUtcDay(day: string): Promise<TradeDisputeLegRow[]>;
  getDaySeal(day: string): Promise<TradeDisputeDaySeal | null>;
  sealDay(day: string): Promise<SealTradeDisputeDayResult>;
  latestRootBefore(day: string): Promise<string | null>;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function disputesUnavailable(): Error {
  return Object.assign(new Error("disputes_unavailable"), { code: "disputes_unavailable" });
}

function utcDayOf(iso: string): string {
  return iso.slice(0, 10);
}

function sortRowsByNewestFirst(rows: TradeDisputeLegRow[]): TradeDisputeLegRow[] {
  return [...rows].sort((a, b) => {
    const ia = Date.parse(a.issued);
    const ib = Date.parse(b.issued);
    if (ib !== ia) return ib - ia;
    const ida = a.id ?? 0;
    const idb = b.id ?? 0;
    if (idb !== ida) return idb - ida;
    return Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt);
  });
}

export function splitCurrentAndHistory(rows: TradeDisputeLegRow[]): TradeDisputeLegsSide {
  if (rows.length === 0) return { current: null, history: [] };
  const sorted = sortRowsByNewestFirst(rows);
  const current = sorted[0] ?? null;
  const history = sorted.slice(1).reverse();
  return { current, history };
}

export function anchorsFromLegSides(
  payer: TradeDisputeLegsSide,
  seller: TradeDisputeLegsSide,
): TradeDisputeDayAnchors {
  return {
    payer: payer.current ? { day: utcDayOf(payer.current.acceptedAt), commitment: payer.current.commitment } : null,
    seller: seller.current
      ? { day: utcDayOf(seller.current.acceptedAt), commitment: seller.current.commitment }
      : null,
  };
}

export async function publicJsonForTrade(
  store: TradeDisputeStore,
  tradeId: string,
): Promise<Awaited<ReturnType<typeof buildPublicClaimsJsonWithChain>> | null> {
  const legs = await store.getLegs(tradeId);
  if (!legs.payer.current && !legs.seller.current && legs.payer.history.length === 0 && legs.seller.history.length === 0) {
    return null;
  }
  const reader = getE6ChainReader(PUBLIC_READ_CHAIN);
  return buildPublicClaimsJsonWithChain(
    {
      tradeId,
      chain: PUBLIC_READ_CHAIN,
      legs: {
        payer: legs.payer,
        seller: legs.seller,
      },
      anchors: anchorsFromLegSides(legs.payer, legs.seller),
    },
    reader,
  );
}

export function memoryTradeDisputeStore(seed: TradeDisputeLegRow[] = []): TradeDisputeStore & {
  rows: Map<string, TradeDisputeLegRow[]>;
  sealed: Map<string, TradeDisputeDaySeal>;
} {
  const rows = new Map<string, TradeDisputeLegRow[]>();
  for (const r of seed) {
    const key = `${r.tradeId.toLowerCase()}:${r.side}`;
    const list = rows.get(key) ?? [];
    list.push(structuredClone(r));
    rows.set(key, list);
  }
  const sealed = new Map<string, TradeDisputeDaySeal>();

  const allRows = (): TradeDisputeLegRow[] => {
    const out: TradeDisputeLegRow[] = [];
    for (const list of rows.values()) out.push(...list);
    return out;
  };

  return {
    rows,
    sealed,
    async getLegs(tradeId) {
      const id = tradeId.toLowerCase();
      const payerRows = rows.get(`${id}:payer`) ?? [];
      const sellerRows = rows.get(`${id}:seller`) ?? [];
      return {
        payer: splitCurrentAndHistory(payerRows),
        seller: splitCurrentAndHistory(sellerRows),
      };
    },
    async countWrites(wallet, utcDay) {
      return countWritesForLimit(allRows(), wallet, utcDay);
    },
    async countLegsForSide(tradeId, side) {
      return countLegsForTradeSide(allRows(), tradeId, side);
    },
    async insertLeg(row) {
      const key = `${row.tradeId.toLowerCase()}:${row.side}`;
      const list = rows.get(key) ?? [];
      if (list.some((r) => r.issued === row.issued)) {
        throw Object.assign(new Error("already_recorded"), { code: "already_recorded" });
      }
      const sorted = sortRowsByNewestFirst(list);
      const current = sorted[0];
      if (current && Date.parse(row.issued) <= Date.parse(current.issued)) {
        throw Object.assign(new Error("stale_claim"), { code: "stale_claim" });
      }
      const wallet = signingWalletForLeg(row);
      const day = utcDayOfIso(row.acceptedAt);
      const walletCount = await this.countWrites(wallet, day);
      if (walletCount >= writeLimitPerWallet) {
        throw Object.assign(new Error("write_limit_reached"), { code: "write_limit_reached" });
      }
      if (tradeSideHistoryLimitExceeded(allRows(), row.tradeId, row.side)) {
        throw Object.assign(new Error("write_limit_reached"), { code: "write_limit_reached" });
      }
      list.push(structuredClone(row));
      rows.set(key, list);
    },
    async listAllLegs() {
      return allRows();
    },
    async listByReceiver(receiver, limit) {
      const w = receiver.toLowerCase();
      const out: TradeDisputeLegRow[] = [];
      for (const r of allRows()) {
        if (r.receiver.toLowerCase() !== w) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    },
    async listLegsForUtcDay(day) {
      if (!DAY_RE.test(day)) return [];
      const start = Date.parse(`${day}T00:00:00.000Z`);
      const end = start + 86_400_000;
      return allRows().filter((r) => {
        const t = Date.parse(r.acceptedAt);
        return t >= start && t < end;
      });
    },
    async getDaySeal(day) {
      return sealed.get(day) ?? null;
    },
    async latestRootBefore(day) {
      let best: string | null = null;
      let bestDay = "";
      for (const [d, v] of sealed) {
        if (d < day && d > bestDay) {
          bestDay = d;
          best = v.rootHash;
        }
      }
      return best;
    },
    async sealDay(day) {
      const prev = await this.latestRootBefore(day);
      const dayRows = await this.listLegsForUtcDay(day);
      const { rootHash, payload, entryCount } = recomputeTradeDisputeDayRoot(
        prev,
        day,
        dayRows.map((r) => ({ commitment: r.commitment, acceptedAt: r.acceptedAt })),
      );
      const existing = sealed.get(day);
      if (existing) {
        if (existing.rootHash !== rootHash) return { status: "conflict_frozen", day };
        return { status: "unchanged", day, rootHash };
      }
      sealed.set(day, { rootHash, prevRoot: prev, entryCount, payload });
      return { status: "sealed", day, rootHash, prevRoot: prev, entryCount };
    },
  };
}

let activeStore: TradeDisputeStore | null = null;

// 本番の neon-http は引数を型の無い文字列として送る。文脈から型が決まらない所（INSERT ... SELECT の列・
// 比較・CASE）では 42804 になりうるので、P2 の書き込みと理由の読み直しの引数には全部、明示の型を付ける
// （試験は tests/dispute-acceptance.pg.test.ts の「型なしの引数」の試験で、全部の引数を text として流す）。
export function tradeClaimInsertSql(
  row: TradeDisputeLegRow,
  limits: { perWallet: number; perTradeSide: number },
) {
  const signer = signingWalletForLeg(row);
  const tradeId = row.tradeId.toLowerCase();
  const utcDay = utcDayOfIso(row.acceptedAt);
  const dayStart = utcDayStartOf(utcDay);
  const dayEnd = utcDayStartOf(shiftDay(utcDay, 1));
  return sql`
    WITH wc AS (
      SELECT count(*)::int AS n FROM trade_dispute_legs
      WHERE signer = ${signer}::text
        AND accepted_at >= ${dayStart}
        AND accepted_at < ${dayEnd}
    ), sc AS (
      SELECT count(*)::int AS n FROM trade_dispute_legs
      WHERE trade_id = ${tradeId}::text AND side = ${row.side}::text
    ), cur AS (
      SELECT issued FROM trade_dispute_legs
      WHERE trade_id = ${tradeId}::text AND side = ${row.side}::text
      ORDER BY issued::timestamptz DESC, id DESC
      LIMIT 1
    )
    INSERT INTO trade_dispute_legs (
      trade_id, side, chain, payer, receiver, payment_info_operator, signer,
      payment_tx, delivery, received_body_sha256, payment_seen, delivered_body_sha256,
      seller_receipt_commitment, seller_receipt_signature, seller_receipt_issued,
      commitment, issued, accepted_at
    )
    SELECT
      ${tradeId}::text,
      ${row.side}::text,
      ${row.chain}::text,
      ${row.payer.toLowerCase()}::text,
      ${row.receiver.toLowerCase()}::text,
      ${row.paymentInfoOperator.toLowerCase()}::text,
      ${signer}::text,
      ${row.paymentTx.toLowerCase()}::text,
      ${row.delivery}::text,
      ${row.receivedBodySha256}::text,
      ${row.paymentSeen}::text,
      ${row.deliveredBodySha256}::text,
      ${row.sellerReceiptCommitment}::text,
      ${row.sellerReceiptSignature}::text,
      ${row.sellerReceiptIssued}::text,
      ${row.commitment}::text,
      ${row.issued}::text,
      ${row.acceptedAt}::timestamptz
    WHERE (SELECT n FROM wc) < ${limits.perWallet}::integer
      AND (SELECT n FROM sc) < ${limits.perTradeSide}::integer
      AND NOT EXISTS (
        SELECT 1 FROM cur WHERE cur.issued::timestamptz >= ${row.issued}::timestamptz
      )
    ON CONFLICT (trade_id, side, issued) DO NOTHING
    RETURNING id
  `;
}

export function tradeClaimDuplicateSql(tradeId: string, side: string, issued: string) {
  return sql`
    SELECT id FROM trade_dispute_legs
    WHERE trade_id = ${tradeId}::text AND side = ${side}::text AND issued = ${issued}::text
    LIMIT 1
  `;
}

export function tradeClaimLatestIssuedSql(tradeId: string, side: string) {
  return sql`
    SELECT issued FROM trade_dispute_legs
    WHERE trade_id = ${tradeId}::text AND side = ${side}::text
    ORDER BY issued::timestamptz DESC, id DESC
    LIMIT 1
  `;
}

export function setTradeDisputeStoreForTests(store: TradeDisputeStore | null): void {
  activeStore = store;
}

export function getTradeDisputeStore(): TradeDisputeStore | null {
  if (activeStore) return activeStore;
  const db = getDb();
  if (!db) return null;
  return pgTradeDisputeStore(db);
}

// neon-http は transaction を持たない。insertLeg は 1 文の条件付き INSERT（下記コメント参照）。
export function pgTradeDisputeStore(db: NonNullable<ReturnType<typeof getDb>> = getDb()!): TradeDisputeStore {
  return {
    async getLegs(tradeId) {
      try {
        const id = tradeId.toLowerCase();
        const legRows = await db
          .select()
          .from(tradeDisputeLegs)
          .where(eq(tradeDisputeLegs.tradeId, id))
          .orderBy(desc(tradeDisputeLegs.acceptedAt), desc(tradeDisputeLegs.id));
        const payerRows: TradeDisputeLegRow[] = [];
        const sellerRows: TradeDisputeLegRow[] = [];
        for (const r of legRows) {
          const mapped = mapLegRow(r);
          if (mapped.side === "payer") payerRows.push(mapped);
          else sellerRows.push(mapped);
        }
        return {
          payer: splitCurrentAndHistory(payerRows),
          seller: splitCurrentAndHistory(sellerRows),
        };
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async countWrites(wallet, utcDay) {
      if (!DAY_RE.test(utcDay)) return 0;
      try {
        const start = utcDayStartOf(utcDay);
        const end = utcDayStartOf(shiftDay(utcDay, 1));
        const w = wallet.toLowerCase();
        const [walletRow] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(tradeDisputeLegs)
          .where(
            and(
              gte(tradeDisputeLegs.acceptedAt, start),
              lt(tradeDisputeLegs.acceptedAt, end),
              eq(tradeDisputeLegs.signer, w),
            ),
          );
        return Number(walletRow?.n ?? 0);
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async countLegsForSide(tradeId, side) {
      try {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(tradeDisputeLegs)
          .where(and(eq(tradeDisputeLegs.tradeId, tradeId.toLowerCase()), eq(tradeDisputeLegs.side, side)));
        return Number(row?.n ?? 0);
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    /**
     * READ COMMITTED では同一署名者の同時 INSERT は互いの未確定行を見ないため、
     * 財布の UTC 日上限（20）と側の履歴上限（10）は同時本数ぶんだけ越えうる（越えるのはその署名者だけ）。
     */
    async insertLeg(row) {
      try {
        const insertResult = await db.execute(
          tradeClaimInsertSql(row, { perWallet: writeLimitPerWallet, perTradeSide: writeLimitPerTradeSide }),
        );
        const inserted = rowsOf<{ id: number }>(insertResult);
        if (inserted.length > 0) return;

        const tradeId = row.tradeId.toLowerCase();
        const dup = rowsOf<{ id: number }>(await db.execute(tradeClaimDuplicateSql(tradeId, row.side, row.issued)));
        if (dup.length > 0) {
          throw Object.assign(new Error("already_recorded"), { code: "already_recorded" });
        }

        const [latest] = rowsOf<{ issued: string }>(await db.execute(tradeClaimLatestIssuedSql(tradeId, row.side)));
        if (latest && Date.parse(row.issued) <= Date.parse(latest.issued)) {
          throw Object.assign(new Error("stale_claim"), { code: "stale_claim" });
        }

        throw Object.assign(new Error("write_limit_reached"), { code: "write_limit_reached" });
      } catch (e) {
        if ((e as { code?: string }).code === "write_limit_reached") throw e;
        if ((e as { code?: string }).code === "stale_claim") throw e;
        if ((e as { code?: string }).code === "already_recorded") throw e;
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async listAllLegs() {
      try {
        const legRows = await db.select().from(tradeDisputeLegs);
        return legRows.map(mapLegRow);
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async listByReceiver(receiver, limit) {
      try {
        const legRows = await db
          .select()
          .from(tradeDisputeLegs)
          .where(sql`lower(${tradeDisputeLegs.receiver}) = ${receiver.toLowerCase()}`)
          .limit(limit);
        return legRows.map(mapLegRow);
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async listLegsForUtcDay(day) {
      if (!DAY_RE.test(day)) return [];
      try {
        const legRows = await db
          .select()
          .from(tradeDisputeLegs)
          .where(
            and(
              gte(tradeDisputeLegs.acceptedAt, utcDayStartOf(day)),
              lt(tradeDisputeLegs.acceptedAt, utcDayStartOf(shiftDay(day, 1))),
            ),
          );
        return legRows.map(mapLegRow);
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async getDaySeal(day) {
      try {
        const [row] = await db.select().from(tradeDisputeDayRoots).where(eq(tradeDisputeDayRoots.day, day));
        if (!row) return null;
        return {
          rootHash: row.rootHash,
          prevRoot: row.prevRoot,
          entryCount: row.entryCount,
          payload: row.payload,
        };
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async latestRootBefore(day) {
      try {
        const rows = await db
          .select({ rootHash: tradeDisputeDayRoots.rootHash, day: tradeDisputeDayRoots.day })
          .from(tradeDisputeDayRoots)
          .where(lt(tradeDisputeDayRoots.day, day))
          .orderBy(sql`${tradeDisputeDayRoots.day} desc`)
          .limit(1);
        return rows[0]?.rootHash ?? null;
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
    async sealDay(day) {
      try {
        const prev = await this.latestRootBefore(day);
        const dayRows = await this.listLegsForUtcDay(day);
        const { rootHash, payload, entryCount } = recomputeTradeDisputeDayRoot(
          prev,
          day,
          dayRows.map((r) => ({ commitment: r.commitment, acceptedAt: r.acceptedAt })),
        );
        const existing = await this.getDaySeal(day);
        if (existing) {
          if (existing.rootHash !== rootHash) return { status: "conflict_frozen", day };
          return { status: "unchanged", day, rootHash };
        }
        await db.insert(tradeDisputeDayRoots).values({
          day,
          rootHash,
          prevRoot: prev,
          entryCount,
          payload,
          sealedAt: sql`now()`,
        });
        return { status: "sealed", day, rootHash, prevRoot: prev, entryCount };
      } catch (e) {
        if (isMissingSchemaError(e)) throw disputesUnavailable();
        throw e;
      }
    },
  };
}

function mapLegRow(r: typeof tradeDisputeLegs.$inferSelect): TradeDisputeLegRow {
  return {
    tradeId: r.tradeId,
    side: r.side as "payer" | "seller",
    chain: r.chain,
    payer: r.payer,
    receiver: r.receiver,
    paymentInfoOperator: r.paymentInfoOperator ?? "",
    signer: r.signer,
    paymentTx: r.paymentTx,
    delivery: r.delivery,
    receivedBodySha256: r.receivedBodySha256,
    paymentSeen: r.paymentSeen,
    deliveredBodySha256: r.deliveredBodySha256,
    sellerReceiptCommitment: r.sellerReceiptCommitment ?? null,
    sellerReceiptSignature: r.sellerReceiptSignature ?? null,
    sellerReceiptIssued: r.sellerReceiptIssued ?? null,
    commitment: r.commitment,
    issued: r.issued,
    acceptedAt: r.acceptedAt.toISOString(),
    id: r.id,
  };
}

let sealFnOverride: ((day: string) => Promise<SealTradeDisputeDayResult>) | null = null;

export function setSealTradeDisputeDayForTests(fn: ((day: string) => Promise<SealTradeDisputeDayResult>) | null): void {
  sealFnOverride = fn;
}

export async function sealTradeDisputeDay(day: string): Promise<SealTradeDisputeDayResult> {
  if (sealFnOverride) return sealFnOverride(day);
  const store = getTradeDisputeStore();
  if (!store) return { status: "unavailable" };
  try {
    return await store.sealDay(day);
  } catch (e) {
    if ((e as { code?: string }).code === "disputes_unavailable") return { status: "unavailable" };
    throw e;
  }
}