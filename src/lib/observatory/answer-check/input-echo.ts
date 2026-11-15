import { createHash } from "node:crypto";
import { declaredRequestBodyFromDoc, declaredRequestUrlFromDoc } from "@/lib/observatory/declared-input-rules";
import { completeBodyOf } from "./body";
import type { AnswerVerdict, StoredAnswer } from "./types";

function isSuccess2xx(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 200 && httpStatus <= 299 && httpStatus !== 202;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function scalarsFromBody(bodyJson: string): Record<string, string | number | boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDecimalNumberString(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t) && Number.isFinite(Number(t));
}

/** 送った数の十進表記が、数の一部ではなく単独の数として現れるか。 */
function standaloneDecimalInText(sent: number, text: string): boolean {
  const re = new RegExp(`(?<![0-9.])${escapeRegExp(String(sent))}(?![0-9]|\\.[0-9])`);
  return re.test(text);
}

function echoMatch(sent: string | number | boolean, got: unknown): boolean {
  if (typeof sent === "number") {
    if (typeof got === "number" && Number.isFinite(got)) return sent === got;
    if (typeof got === "string") {
      const t = got.trim();
      if (t === "") return false;
      if (isDecimalNumberString(t)) return sent === Number(t);
      return standaloneDecimalInText(sent, got);
    }
    return false;
  }
  if (typeof sent === "boolean") {
    if (typeof got === "boolean") return sent === got;
    if (typeof got === "string") {
      const t = got.trim().toLowerCase();
      if (t === "true" || t === "false") return sent === (t === "true");
    }
    return false;
  }
  const s = String(sent).trim();
  const g = String(got).trim();
  if (s === "" || g === "") return s === "" && g === "";
  const sl = s.toLowerCase();
  const gl = g.toLowerCase();
  // 文字列は trim と小文字の完全一致だけ（ja と "Japanese" の含み関係を一致に数えない）。数の境界付きの一致は上の数の枝だけ。
  return sl === gl;
}

export function checkInputEcho(a: StoredAnswer): AnswerVerdict {
  if (!isSuccess2xx(a.httpStatus)) {
    return { check: "input_echo", result: "not_applicable", reason: "not_success_2xx" };
  }
  const sentScalars: Record<string, string | number | boolean> = {};
  if (a.requestQuery === "declared" && !a.resourceUrl) {
    return { check: "input_echo", result: "not_checked", reason: "sent_values_unverified" };
  }
  if (a.requestQuery === "declared" && a.resourceUrl) {
    const { query, source } = declaredRequestUrlFromDoc({ resourceUrl: a.resourceUrl, document: a.challengeDocument });
    if (source !== "declared" || !query) {
      return { check: "input_echo", result: "not_checked", reason: "sent_values_unverified" };
    }
    if (sha256(query) !== (a.requestQuerySha256 ?? "")) {
      return { check: "input_echo", result: "not_checked", reason: "sent_values_unverified" };
    }
    for (const [k, v] of new URLSearchParams(query)) {
      const n = Number(v);
      sentScalars[k] = v !== "" && !Number.isNaN(n) && String(n) === v ? n : v;
    }
  }
  if (a.requestBody === "declared") {
    const { body, source } = declaredRequestBodyFromDoc(a.challengeDocument);
    if (source !== "declared") {
      return { check: "input_echo", result: "not_checked", reason: "sent_values_unverified" };
    }
    if (sha256(body) !== (a.requestBodySha256 ?? "")) {
      return { check: "input_echo", result: "not_checked", reason: "sent_values_unverified" };
    }
    Object.assign(sentScalars, scalarsFromBody(body));
  }
  const body = completeBodyOf(a);
  if (body === null) {
    return { check: "input_echo", result: "not_checked", reason: "body_longer_than_stored_head" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { check: "input_echo", result: "not_applicable", reason: "not_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { check: "input_echo", result: "not_applicable", reason: "not_object" };
  }
  const resp = parsed as Record<string, unknown>;
  const keysToCheck = Object.keys(sentScalars).filter((k) => {
    const v = resp[k];
    return v !== undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  });
  if (keysToCheck.length === 0) {
    return { check: "input_echo", result: "not_applicable", reason: "no_echo_field" };
  }
  for (const key of keysToCheck) {
    if (!echoMatch(sentScalars[key]!, resp[key])) {
      return {
        check: "input_echo",
        result: "not_checked",
        reason: "echo_not_confirmed",
        detail: { key, sent: sentScalars[key], got: resp[key] },
      };
    }
  }
  return { check: "input_echo", result: "pass", reason: "echo_match" };
}