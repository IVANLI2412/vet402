import { looksLikeJson } from "@/lib/observatory/l2-check";
import { completeBodyOf } from "./body";
import type { AnswerVerdict, StoredAnswer } from "./types";

function isSuccess2xx(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 200 && httpStatus <= 299 && httpStatus !== 202;
}

export function checkJsonValid(a: StoredAnswer): AnswerVerdict {
  if (!isSuccess2xx(a.httpStatus)) {
    return { check: "json_valid", result: "not_applicable", reason: "not_success_2xx" };
  }
  const ct = (a.contentType ?? "").toLowerCase();
  const body = completeBodyOf(a);
  // fail を出せるのは Content-Type が application/json か +json（1 個の JSON 値を名乗る）のときだけ。
  // application/x-ndjson・application/jsonl・application/json-seq などの流れの形は、正しい本文でも JSON.parse が落ちるので not_checked。
  const mime = ct.split(";")[0]!.trim();
  const declaresJson = mime === "application/json" || /^[a-z0-9.+-]+\/[a-z0-9.+-]*\+json$/.test(mime);
  if (!declaresJson && ct.includes("json")) {
    return { check: "json_valid", result: "not_checked", reason: "not_single_json_content_type" };
  }
  if (!declaresJson) {
    const head = typeof a.bodyHead === "string" ? a.bodyHead : "";
    if (looksLikeJson(head) && body !== null) {
      try {
        JSON.parse(body);
        return { check: "json_valid", result: "pass", reason: "valid_json" };
      } catch {
        return { check: "json_valid", result: "not_checked", reason: "unparseable" };
      }
    }
    return { check: "json_valid", result: "not_applicable", reason: "not_json" };
  }
  if (body === null) {
    return { check: "json_valid", result: "not_checked", reason: "body_longer_than_stored_head" };
  }
  // 空・空白だけの本文は不正な JSON の確かな証拠にしない（not_checked）。本文の長さの記録が無い行は、頭が全文か分からない。
  if (body.trim().length === 0) {
    return { check: "json_valid", result: "not_checked", reason: "empty_body" };
  }
  if (a.bodyBytes === null || a.bodyBytes === undefined) {
    return { check: "json_valid", result: "not_checked", reason: "body_length_unknown" };
  }
  try {
    JSON.parse(body);
    return { check: "json_valid", result: "pass", reason: "valid_json" };
  } catch {
    return { check: "json_valid", result: "fail", reason: "unparseable" };
  }
}