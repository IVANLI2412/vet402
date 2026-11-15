import { answerShapeOf as failureBodyShapeOf } from "@/lib/observatory/answer-shape";
import {
  binaryKindOfDecodedText,
  binaryMediaTypeFromCatalog,
  binaryMediaTypeFromDocument,
  catalogDeclaresOutput,
} from "@/lib/observatory/l2-check";
import { completeBodyOf } from "./body";
import { jsonOutputDeclaredFromChallenge } from "./output-declared";
import type { AnswerVerdict, StoredAnswer } from "./types";

function isSuccess2xx(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 200 && httpStatus <= 299 && httpStatus !== 202;
}

export type JsonKeyType = "string" | "number" | "boolean" | "null" | "object" | "array";

export type AnswerShape = {
  kind: "json_object" | "json_array" | "html" | "text" | "empty" | `binary:${string}`;
  keys?: Record<string, JsonKeyType>;
  /** 配列の先頭要素の種類（先頭がプレーンオブジェクトでないとき） */
  arrayElem?: JsonKeyType;
};

function topLevelJsonType(v: unknown): JsonKeyType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "string";
}

function isEmptyArrayShape(shape: AnswerShape): boolean {
  return shape.kind === "json_array" && shape.keys === undefined && shape.arrayElem === undefined;
}

function keyTypesFromRecord(obj: Record<string, unknown>): Record<string, JsonKeyType> {
  const keys: Record<string, JsonKeyType> = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    keys[k] = topLevelJsonType(v);
  }
  return keys;
}

function shapeFromJsonValue(parsed: unknown): AnswerShape {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { kind: "json_array" };
    const first = parsed[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      return { kind: "json_array", keys: keyTypesFromRecord(first as Record<string, unknown>) };
    }
    return { kind: "json_array", arrayElem: topLevelJsonType(first) };
  }
  if (typeof parsed === "object" && parsed !== null) {
    return { kind: "json_object", keys: keyTypesFromRecord(parsed as Record<string, unknown>) };
  }
  return { kind: "json_object" };
}

export function shapeToReadable(shape: AnswerShape): string {
  if (shape.kind === "json_object" || shape.kind === "json_array") {
    const keyPart =
      shape.keys && Object.keys(shape.keys).length > 0
        ? `{${Object.keys(shape.keys)
            .sort()
            .map((k) => `${k}:${shape.keys![k]}`)
            .join(",")}}`
        : shape.arrayElem
          ? `{0:${shape.arrayElem}}`
          : "{}";
    return `${shape.kind}${keyPart}`;
  }
  return shape.kind;
}

function attemptedAtMs(at: string): number | null {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/** 保存済みの全文から応答の形を表す。頭だけのとき null（バイナリは completeBodyOf に依らない）。 */
export function answerShapeOf(a: StoredAnswer): AnswerShape | null {
  if (typeof a.bodyHead === "string" && a.bodyBytes !== null && a.bodyBytes > 0) {
    const bin = binaryKindOfDecodedText(a.bodyHead);
    if (bin) return { kind: `binary:${bin.kind}` };
  }
  const body = completeBodyOf(a);
  if (body === null) return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  if (trimmed.startsWith("<")) return { kind: "html" };
  const bin = binaryKindOfDecodedText(trimmed);
  if (bin) return { kind: `binary:${bin.kind}` };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return shapeFromJsonValue(parsed);
    } catch {
      return null;
    }
  }
  return { kind: "text" };
}

function shapesEqual(a: AnswerShape, b: AnswerShape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "json_array" && b.kind === "json_array") {
    const aObjKeys = a.keys !== undefined;
    const bObjKeys = b.keys !== undefined;
    if (aObjKeys !== bObjKeys) return false;
    if (a.arrayElem !== b.arrayElem) return false;
  }
  const ak = a.keys ?? {};
  const bk = b.keys ?? {};
  const aKeys = Object.keys(ak).sort();
  const bKeys = Object.keys(bk).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    const k = aKeys[i]!;
    const at = ak[k];
    const bt = bk[k];
    if (at === "null" || bt === "null") continue;
    if (at !== bt) return false;
  }
  return true;
}

function isDynamicTopLevelKey(key: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(key)) return true;
  if (/^\d+$/.test(key)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(key)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
}

function shapeHasDynamicKeys(shape: AnswerShape): boolean {
  if (shape.kind !== "json_object" || !shape.keys) return false;
  const keys = Object.keys(shape.keys);
  if (keys.length < 2) return false;
  const dynamic = keys.filter(isDynamicTopLevelKey).length;
  return dynamic >= keys.length / 2;
}

function compareToBaseline(
  baseline: AnswerShape,
  current: AnswerShape,
): { result: "not_applicable"; reason: string; detail: Record<string, unknown> } {
  const from = shapeToReadable(baseline);
  const to = shapeToReadable(current);
  if (baseline.kind !== current.kind) {
    return { result: "not_applicable", reason: "shape_changed", detail: { from, to, typeChanged: true } };
  }
  if (baseline.kind === "json_array" && current.kind === "json_array") {
    const baseEmpty = isEmptyArrayShape(baseline);
    const curEmpty = isEmptyArrayShape(current);
    if (baseEmpty || curEmpty) {
      const baseKeys = baseline.keys ?? {};
      const curKeys = current.keys ?? {};
      const added = Object.keys(curKeys).filter((k) => !Object.hasOwn(baseKeys, k));
      if (added.length > 0 && Object.keys(baseKeys).every((k) => Object.hasOwn(curKeys, k))) {
        return { result: "not_applicable", reason: "keys_added", detail: { addedKeys: added } };
      }
      return { result: "not_applicable", reason: "same_shape", detail: {} };
    }
    const baseObj = baseline.keys !== undefined;
    const curObj = current.keys !== undefined;
    if (baseObj !== curObj) {
      return { result: "not_applicable", reason: "shape_changed", detail: { from, to, typeChanged: true } };
    }
    if (!baseObj && baseline.arrayElem !== current.arrayElem) {
      return { result: "not_applicable", reason: "shape_changed", detail: { from, to, typeChanged: true } };
    }
  }
  const baseKeys = baseline.keys ?? {};
  const curKeys = current.keys ?? {};
  const removed = Object.keys(baseKeys).filter((k) => !Object.hasOwn(curKeys, k));
  if (removed.length > 0) {
    return { result: "not_applicable", reason: "shape_changed", detail: { from, to, removedKeys: removed } };
  }
  const typeChanges: { key: string; from: JsonKeyType; to: JsonKeyType }[] = [];
  for (const key of Object.keys(baseKeys)) {
    if (!Object.hasOwn(curKeys, key)) continue;
    const bt = baseKeys[key]!;
    const ct = curKeys[key]!;
    if (bt === "null" || ct === "null") continue;
    if (bt !== ct) typeChanges.push({ key, from: bt, to: ct });
  }
  if (typeChanges.length > 0) {
    return {
      result: "not_applicable",
      reason: "shape_changed",
      detail: { from, to, typeChanged: typeChanges },
    };
  }
  const added = Object.keys(curKeys).filter((k) => !Object.hasOwn(baseKeys, k));
  if (added.length > 0) {
    return { result: "not_applicable", reason: "keys_added", detail: { addedKeys: added } };
  }
  if (shapesEqual(baseline, current)) {
    return { result: "not_applicable", reason: "same_shape", detail: {} };
  }
  return { result: "not_applicable", reason: "shape_changed", detail: { from, to } };
}

function listingHasDeclaration(a: StoredAnswer): boolean {
  if (catalogDeclaresOutput(a.catalogDeclaredSchema)) return true;
  if (jsonOutputDeclaredFromChallenge(a)) return true;
  if (binaryMediaTypeFromDocument(a.challengeDocument)) return true;
  if (binaryMediaTypeFromCatalog(a.catalogDeclaredSchema)) return true;
  return false;
}

function judgeOneShapeRow(
  a: StoredAnswer,
  baseline: AnswerShape | null,
  baselineId: string | null,
): { verdict: AnswerVerdict; baseline: AnswerShape | null; baselineId: string | null } {
  if (listingHasDeclaration(a)) {
    return {
      verdict: { check: "shape_drift", result: "not_applicable", reason: "declared" },
      baseline,
      baselineId,
    };
  }
  if (!isSuccess2xx(a.httpStatus)) {
    return {
      verdict: { check: "shape_drift", result: "not_applicable", reason: "not_success_2xx" },
      baseline,
      baselineId,
    };
  }
  if (attemptedAtMs(a.attemptedAt) === null) {
    return {
      verdict: { check: "shape_drift", result: "not_checked", reason: "bad_attempted_at" },
      baseline,
      baselineId,
    };
  }
  const shape = answerShapeOf(a);
  if (shape === null) {
    return {
      verdict: { check: "shape_drift", result: "not_checked", reason: "no_full_body" },
      baseline,
      baselineId,
    };
  }
  const bodyForFailure = completeBodyOf(a);
  if (
    shape.kind === "empty" ||
    shape.kind === "html" ||
    (bodyForFailure !== null && failureBodyShapeOf(bodyForFailure, a.contentType) !== null)
  ) {
    return {
      verdict: { check: "shape_drift", result: "not_applicable", reason: "failure_like_body" },
      baseline,
      baselineId,
    };
  }
  if (shapeHasDynamicKeys(shape)) {
    return {
      verdict: { check: "shape_drift", result: "not_applicable", reason: "dynamic_keys" },
      baseline,
      baselineId,
    };
  }
  if (baseline === null) {
    return {
      verdict: { check: "shape_drift", result: "not_applicable", reason: "baseline" },
      baseline: shape,
      baselineId: a.purchaseId,
    };
  }
  const cmp = compareToBaseline(baseline, shape);
  const detail =
    Object.keys(cmp.detail).length > 0 ? { ...cmp.detail, baselinePurchaseId: baselineId } : { baselinePurchaseId: baselineId };
  return {
    verdict: {
      check: "shape_drift",
      result: cmp.result,
      reason: cmp.reason,
      ...(Object.keys(cmp.detail).length > 0 ? { detail } : {}),
    },
    baseline,
    baselineId,
  };
}

export function checkShapeDrift(answers: StoredAnswer[]): Map<string, AnswerVerdict> {
  const out = new Map<string, AnswerVerdict>();
  const byEndpoint = new Map<string, StoredAnswer[]>();
  for (const a of answers) {
    const list = byEndpoint.get(a.endpointKey) ?? [];
    list.push(a);
    byEndpoint.set(a.endpointKey, list);
  }
  for (const [, rows] of byEndpoint) {
    rows.sort((x, y) => {
      const tx = attemptedAtMs(x.attemptedAt);
      const ty = attemptedAtMs(y.attemptedAt);
      if (tx === null && ty === null) return 0;
      if (tx === null) return 1;
      if (ty === null) return -1;
      return tx - ty;
    });
    let baseline: AnswerShape | null = null;
    let baselineId: string | null = null;
    for (const a of rows) {
      try {
        const judged = judgeOneShapeRow(a, baseline, baselineId);
        baseline = judged.baseline;
        baselineId = judged.baselineId;
        out.set(a.purchaseId, judged.verdict);
      } catch {
        out.set(a.purchaseId, { check: "shape_drift", result: "not_checked", reason: "judge_error" });
      }
    }
  }
  return out;
}