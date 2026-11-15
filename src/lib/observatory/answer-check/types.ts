// 台帳に保存された購入行と、応答本文に対する判定の型（J1・内部試験用）。

export type StoredAnswer = {
  purchaseId: string;
  endpointKey: string;
  attemptedAt: string;
  status: string;
  httpStatus: number | null;
  contentType: string | null;
  bodyHead: string;
  bodyBytes: number | null;
  resourceUrl: string | null;
  challengeDocument: unknown;
  requestQuery: "declared" | "empty" | "refused" | null;
  requestQuerySha256: string | null;
  requestBody: "declared" | "empty" | "none" | null;
  requestBodySha256: string | null;
  catalogDeclaredSchema: unknown;
  l2Reading: string | null;
  /** 呼び手が設定。raw_response_meta の bodyError / bodyTruncated、または l2 が body_over_cap 等のとき true。 */
  bodyIncomplete: boolean | null;
};

export type AnswerCheckName = "json_valid" | "declared_type" | "shape_drift" | "input_echo" | "binary_kind";

export type AnswerVerdict = {
  check: AnswerCheckName;
  result: "pass" | "fail" | "not_checked" | "not_applicable";
  reason: string;
  detail?: Record<string, unknown>;
};