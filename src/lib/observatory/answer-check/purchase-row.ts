import { l2ReadingOf } from "@/lib/observatory/l2-check";
import type { StoredAnswer } from "./types";

const BODY_INCOMPLETE_REASONS = new Set(["body_over_cap", "body_timeout", "body_read_error"]);

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function requestQueryOf(meta: Record<string, unknown>): StoredAnswer["requestQuery"] {
  const v = meta.requestQuery;
  if (v === "declared" || v === "empty" || v === "refused") return v;
  return null;
}

function requestBodyOf(meta: Record<string, unknown>): StoredAnswer["requestBody"] {
  const v = meta.requestBody;
  if (v === "declared" || v === "empty" || v === "none") return v;
  return null;
}

function bodyIncompleteOf(meta: Record<string, unknown>): boolean | null {
  if (meta.bodyTruncated === true) return true;
  const l2 = meta.l2;
  if (typeof l2 === "object" && l2 !== null) {
    const reason = (l2 as Record<string, unknown>).reason;
    if (typeof reason === "string" && BODY_INCOMPLETE_REASONS.has(reason)) return true;
  }
  if (meta.bodyError !== undefined && meta.bodyError !== null) return true;
  return null;
}

/** DB の購入行 + エンドポイント宣言から StoredAnswer を組む（ネットワーク無し）。 */
export function storedAnswerFromPurchaseRow(input: {
  purchaseId: string;
  endpointKey: string;
  attemptedAt: string;
  status: string;
  httpStatusPaid: number | null;
  l2Schema: string | null;
  rawResponseMeta: unknown;
  challengeDocument: unknown;
  catalogDeclaredSchema: unknown;
  resourceUrl?: string | null;
}): StoredAnswer {
  const meta =
    typeof input.rawResponseMeta === "object" && input.rawResponseMeta !== null && !Array.isArray(input.rawResponseMeta)
      ? (input.rawResponseMeta as Record<string, unknown>)
      : {};
  const l2Detail = typeof meta.l2 === "object" && meta.l2 !== null ? meta.l2 : null;
  const l2Reading = l2ReadingOf(
    {
      l2Schema: input.l2Schema,
      l2Detail,
      bodyHead: metaString(meta, "bodyHead"),
      contentType: metaString(meta, "contentType"),
    },
    input.catalogDeclaredSchema,
  );
  return {
    purchaseId: input.purchaseId,
    endpointKey: input.endpointKey,
    attemptedAt: input.attemptedAt,
    status: input.status,
    httpStatus: input.httpStatusPaid,
    contentType: metaString(meta, "contentType"),
    bodyHead: metaString(meta, "bodyHead") ?? "",
    bodyBytes: metaNumber(meta, "bodyBytes"),
    resourceUrl: input.resourceUrl ?? null,
    challengeDocument: input.challengeDocument ?? {},
    requestQuery: requestQueryOf(meta),
    requestQuerySha256: metaString(meta, "requestQuerySha256"),
    requestBody: requestBodyOf(meta),
    requestBodySha256: metaString(meta, "requestBodySha256"),
    catalogDeclaredSchema: input.catalogDeclaredSchema,
    l2Reading,
    bodyIncomplete: bodyIncompleteOf(meta),
  };
}