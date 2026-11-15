import { declaredOutputOf, liveOutputExampleOf, liveOutputSchemaOf } from "@/lib/observatory/l2-check";
import type { StoredAnswer } from "./types";

/** 402 文書の JSON 出力宣言（必須キーまたはプロパティ）があるか。 */
export function jsonOutputDeclaredFromChallenge(a: Pick<StoredAnswer, "catalogDeclaredSchema" | "challengeDocument">): boolean {
  const doc = a.challengeDocument;
  const liveEx = liveOutputExampleOf({ bodyText: JSON.stringify(doc) });
  const liveSchema = liveOutputSchemaOf({ bodyText: JSON.stringify(doc) });
  const { requiredKeys, exampleProps } = declaredOutputOf(a.catalogDeclaredSchema, liveEx, liveSchema);
  return requiredKeys.length > 0 || exampleProps !== null;
}