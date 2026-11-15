import {
  binaryMediaTypeFromCatalog,
  binaryMediaTypeFromDocument,
  checkL2Binary,
} from "@/lib/observatory/l2-check";
import type { AnswerVerdict, StoredAnswer } from "./types";

function isSuccess2xx(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 200 && httpStatus <= 299 && httpStatus !== 202;
}

export function checkBinaryKind(a: StoredAnswer): AnswerVerdict {
  if (!isSuccess2xx(a.httpStatus)) {
    return { check: "binary_kind", result: "not_applicable", reason: "not_success_2xx" };
  }
  const mediaType = binaryMediaTypeFromDocument(a.challengeDocument) ?? binaryMediaTypeFromCatalog(a.catalogDeclaredSchema);
  if (!mediaType) {
    return { check: "binary_kind", result: "not_applicable", reason: "no_binary_declaration" };
  }
  if (a.bodyIncomplete === true) {
    return { check: "binary_kind", result: "not_checked", reason: "body_incomplete" };
  }
  if (a.bodyBytes === 0) {
    return { check: "binary_kind", result: "not_checked", reason: "binary_empty" };
  }
  // 頭が文字列でない行（記録が欠けた行）は空の応答と決めつけない（売り手への冤罪を避ける）。
  if (typeof a.bodyHead !== "string") {
    return { check: "binary_kind", result: "not_checked", reason: "bad_body_head" };
  }
  const bodyHead = a.bodyHead;
  if (bodyHead.trim().length === 0) {
    return { check: "binary_kind", result: "not_checked", reason: "binary_empty" };
  }
  const bin = checkL2Binary({
    mediaType,
    body: bodyHead,
    contentType: a.contentType,
    bodyIncomplete: null,
  });
  if (bin.status === "match") {
    return { check: "binary_kind", result: "pass", reason: "match", detail: { exact: bin.exact } };
  }
  if (bin.status === "not_checked") {
    return { check: "binary_kind", result: "not_checked", reason: bin.reason ?? "not_checked" };
  }
  return {
    check: "binary_kind",
    result: "fail",
    reason: bin.reason ?? "mismatch",
    detail: { exact: bin.exact, detectedKind: bin.detectedKind },
  };
}