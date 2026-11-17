import { answerShapeOf } from "./shape-drift";
import { completeBodyOf } from "./body";
import type { StoredAnswer } from "./types";

function isSuccess2xx(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 200 && httpStatus <= 299 && httpStatus !== 202;
}

/** 掲載ごとの形の基準にできる保存済み応答か（completeBodyOf・2xx・パース可能な JSON の全文）。 */
export function qualifiesAsEndpointShapeBaseline(a: StoredAnswer): boolean {
  if (!isSuccess2xx(a.httpStatus)) return false;
  const body = completeBodyOf(a);
  if (body === null) return false;
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
  } catch {
    return false;
  }
  const shape = answerShapeOf(a);
  if (shape === null) return false;
  if (shape.kind !== "json_object" && shape.kind !== "json_array") return false;
  return true;
}