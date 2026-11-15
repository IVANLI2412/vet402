import { unstable_cache } from "next/cache";
import { buildJudgment, buildJudgmentShard, type JudgmentShardRow } from "./build";
import { isTransientJudgment } from "./public-judgment";

/** 日次のキャッシュに載せない判定を、投げて unstable_cache に保存させずに外へ運ぶ（失敗と同じ扱い）。 */
class TransientJudgment extends Error {
  constructor(readonly doc: Record<string, unknown>) {
    super("transient_judgment");
  }
}

export type JudgmentCacheFn = typeof unstable_cache;

export type JudgmentReaders = {
  readShard: (prefix: string, day: string) => Promise<JudgmentShardRow[]>;
  readJudgment: (resourceId: string, day: string) => Promise<Record<string, unknown> | null>;
};

export function makeJudgmentReaders(
  cache: JudgmentCacheFn,
  deps: {
    buildJudgment: typeof buildJudgment;
    buildJudgmentShard: typeof buildJudgmentShard;
  } = { buildJudgment, buildJudgmentShard },
): JudgmentReaders {
  const readShard = (prefix: string, day: string): Promise<JudgmentShardRow[]> => {
    const inner = cache(
      async () => deps.buildJudgmentShard(prefix),
      ["judgments:shard:v1", prefix, day],
      { revalidate: 86400, tags: ["judgments"] },
    );
    return inner();
  };

  const readJudgment = (resourceId: string, day: string): Promise<Record<string, unknown> | null> => {
    const inner = cache(
      async () => {
        const doc = await deps.buildJudgment(resourceId, day);
        // spending_halted（停止フラグの読み取り失敗でも true）と degraded の判定は 1 日持たない。
        if (doc && isTransientJudgment(doc)) throw new TransientJudgment(doc);
        return doc;
      },
      ["judgments:doc:v1", resourceId, day],
      { revalidate: 86400, tags: ["judgments"] },
    );
    return inner().catch((error: unknown) => {
      if (error instanceof TransientJudgment) return error.doc;
      throw error;
    });
  };

  return { readShard, readJudgment };
}

export const judgmentReaders = makeJudgmentReaders(unstable_cache);