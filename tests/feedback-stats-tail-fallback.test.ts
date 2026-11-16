// ============================================================
// tail の eth_getLogs が落ちても、窓を覆う索引があり尾が上限以内なら stats を返す（2026-11-16）。
// 尾が FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS を超えるときは fail-closed。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRecentFeedbackStats } from "@/lib/chain/erc8004";
import type { IndexedFeedbackWindow } from "@/lib/db/feedback-index";
import { DeadlineExceededError } from "@/lib/util/deadline";
import { assessSybilRisk } from "@/lib/scoring/verdict";

const TIP = 52_556_796n;

function sampleIndex(over?: Partial<IndexedFeedbackWindow>): IndexedFeedbackWindow {
  return {
    coverageStart: 51_100_000n,
    checkpoint: TIP - 50n,
    entries: [
      {
        clientAddress: "0xabcdef0000000000000000000000000000000001",
        blockNumber: TIP - 10_000n,
        txHash: "0xfeed0001",
        logIndex: 0,
      },
      {
        clientAddress: "0xabcdef0000000000000000000000000000000002",
        blockNumber: TIP - 20_000n,
        txHash: "0xfeed0002",
        logIndex: 0,
      },
    ],
    ...over,
  };
}

const tailFail = () => {
  throw new DeadlineExceededError("getLogsChunked", 2_500);
};

function withFailopenEnv(
  value: string | undefined,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const prev = process.env.FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS;
    if (value === undefined) {
      delete process.env.FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS;
    } else {
      process.env.FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS = value;
    }
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS;
      else process.env.FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS = prev;
    }
  };
}

test(
  "尾 900 ブロックで getLogs が期限切れでも索引だけで stats を返し、unavailable にはならない",
  withFailopenEnv(undefined, async () => {
    const stats = await fetchRecentFeedbackStats(7n, 7, 8453, {
      latestBlock: TIP,
      getIndex: async () => sampleIndex({ checkpoint: TIP - 900n }),
      scanTail: tailFail,
    });
    assert.equal(stats.recentCount, 2);
    assert.equal(stats.uniqueClients, 2);
    assert.notEqual(assessSybilRisk(["feedback_stats_unavailable"]), assessSybilRisk([]));
  }),
);

test(
  "尾 20000 ブロックで getLogs が落ちれば fail-closed（既定上限 18000 超）",
  withFailopenEnv(undefined, async () => {
    await assert.rejects(
      () =>
        fetchRecentFeedbackStats(7n, 7, 8453, {
          latestBlock: TIP,
          getIndex: async () => sampleIndex({ checkpoint: TIP - 20000n }),
          scanTail: tailFail,
        }),
      (err: unknown) => err instanceof DeadlineExceededError,
    );
  }),
);

test(
  "尾が RPC エラーでも索引だけで stats を返す（尾 900 ブロック）",
  withFailopenEnv(undefined, async () => {
    const stats = await fetchRecentFeedbackStats(7n, 7, 8453, {
      latestBlock: TIP,
      getIndex: async () => sampleIndex({ checkpoint: TIP - 900n }),
      scanTail: async () => {
        throw new Error("RpcRequestError: limit");
      },
    });
    assert.equal(stats.recentCount, 2);
  }),
);

test(
  "FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS で上限を広げれば尾 20000 でも索引だけで返す",
  withFailopenEnv("25000", async () => {
    const stats = await fetchRecentFeedbackStats(7n, 7, 8453, {
      latestBlock: TIP,
      getIndex: async () => sampleIndex({ checkpoint: TIP - 20000n }),
      scanTail: tailFail,
    });
    assert.equal(stats.recentCount, 2);
  }),
);

test(
  "FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS の不正値は既定 18000（尾 20000 は throw）",
  withFailopenEnv("not-a-number", async () => {
    await assert.rejects(
      () =>
        fetchRecentFeedbackStats(7n, 7, 8453, {
          latestBlock: TIP,
          getIndex: async () => sampleIndex({ checkpoint: TIP - 20000n }),
          scanTail: tailFail,
        }),
      (err: unknown) => err instanceof DeadlineExceededError,
    );
  }),
);

test("索引が無く full scan も許されないときは feedback_stats_unavailable", async () => {
  await assert.rejects(
    () =>
      fetchRecentFeedbackStats(7n, 7, 8453, {
        latestBlock: TIP,
        getIndex: async () => null,
      }),
    /feedback_stats_unavailable:index_absent/,
  );
});
test(
  "境界: 尾がちょうど 18000 なら索引だけで返し、18001 なら fail-closed",
  withFailopenEnv(undefined, async () => {
    const ok = await fetchRecentFeedbackStats(7n, 7, 8453, {
      latestBlock: TIP,
      getIndex: async () => sampleIndex({ checkpoint: TIP - 18000n }),
      scanTail: tailFail,
    });
    assert.equal(ok.recentCount, 2);
    await assert.rejects(
      () =>
        fetchRecentFeedbackStats(7n, 7, 8453, {
          latestBlock: TIP,
          getIndex: async () => sampleIndex({ checkpoint: TIP - 18001n }),
          scanTail: tailFail,
        }),
      (err: unknown) => err instanceof DeadlineExceededError,
    );
  }),
);

test(
  "FEEDBACK_TAIL_FAILOPEN_MAX_BLOCKS=0 や負数は既定 18000（尾 18001 は throw・尾 900 は返す）",
  withFailopenEnv("0", async () => {
    await assert.rejects(
      () =>
        fetchRecentFeedbackStats(7n, 7, 8453, {
          latestBlock: TIP,
          getIndex: async () => sampleIndex({ checkpoint: TIP - 18001n }),
          scanTail: tailFail,
        }),
      (err: unknown) => err instanceof DeadlineExceededError,
    );
    const ok = await fetchRecentFeedbackStats(7n, 7, 8453, {
      latestBlock: TIP,
      getIndex: async () => sampleIndex({ checkpoint: TIP - 900n }),
      scanTail: tailFail,
    });
    assert.equal(ok.recentCount, 2);
  }),
);
