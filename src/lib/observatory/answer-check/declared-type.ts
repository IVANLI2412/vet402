import { declaredOutputOf, l2DeclarationKindOf, liveOutputExampleOf, liveOutputSchemaOf } from "@/lib/observatory/l2-check";
import { completeBodyOf } from "./body";
import type { AnswerVerdict, StoredAnswer } from "./types";

const JSON_SCHEMA_TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

const JSON_SCHEMA_VOCABULARY = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "format",
  "description",
  "title",
  "default",
  "examples",
  "example",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "nullable",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "contentMediaType",
  "contentEncoding",
  "$ref",
  "$schema",
]);

function isSuccess2xx(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 200 && httpStatus <= 299 && httpStatus !== 202;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value) && typeof value === "number") return "integer";
  return typeof value;
}

function isJsonSchemaProp(node: unknown): boolean {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return false;
  const rec = node as Record<string, unknown>;
  const t = rec.type;
  const keys = Object.keys(rec);
  const vocabOnly = keys.every((k) => JSON_SCHEMA_VOCABULARY.has(k));
  if (!vocabOnly) return false;
  if (typeof t === "string") return JSON_SCHEMA_TYPE_NAMES.has(t);
  if (Array.isArray(t)) return t.length > 0 && t.every((x) => typeof x === "string" && JSON_SCHEMA_TYPE_NAMES.has(x));
  return false;
}

function declaredTypeOfProp(propDef: unknown): string | null {
  if (isJsonSchemaProp(propDef)) {
    const rec = propDef as Record<string, unknown>;
    if (typeof rec.type === "string") return rec.type;
    if (Array.isArray(rec.type)) return rec.type.map(String).join("|");
  }
  if (propDef === undefined) return null;
  if (typeof propDef === "number") return "number";
  return jsonTypeOf(propDef);
}

function typesCompatible(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  if (declared === "number" && actual === "integer") return true;
  if (declared === "integer" && actual === "integer") return true;
  if (declared.includes("|")) {
    return declared.split("|").some((t) => typesCompatible(t.trim(), actual));
  }
  return false;
}

export function checkDeclaredType(a: StoredAnswer): AnswerVerdict {
  if (!isSuccess2xx(a.httpStatus)) {
    return { check: "declared_type", result: "not_applicable", reason: "not_success_2xx" };
  }
  const doc = a.challengeDocument;
  const liveEx = liveOutputExampleOf({ bodyText: JSON.stringify(doc) });
  const liveSchema = liveOutputSchemaOf({ bodyText: JSON.stringify(doc) });
  const { exampleProps } = declaredOutputOf(a.catalogDeclaredSchema, liveEx, liveSchema);
  // 宣言が見本の値（402 の output.example）なら、値が {"type":"string"} のように JSON Schema の語だけでできていても
  // 型の宣言とみなさない（見本どおりの応答を fail にしない）。
  const fromExample = l2DeclarationKindOf(a.catalogDeclaredSchema, liveEx, liveSchema) === "example";
  if (!exampleProps) {
    return { check: "declared_type", result: "not_applicable", reason: "no_type_declaration" };
  }
  if (a.bodyBytes === null || a.bodyBytes === undefined) {
    return { check: "declared_type", result: "not_checked", reason: "body_length_unknown" };
  }
  const body = completeBodyOf(a);
  if (body === null) {
    return { check: "declared_type", result: "not_checked", reason: "body_longer_than_stored_head" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { check: "declared_type", result: "not_checked", reason: "unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { check: "declared_type", result: "not_applicable", reason: "not_object" };
  }
  const resp = parsed as Record<string, unknown>;
  const propsSchema =
    typeof exampleProps === "object" && exampleProps !== null && !Array.isArray(exampleProps)
      ? (exampleProps as Record<string, unknown>)
      : null;
  if (!propsSchema) {
    return { check: "declared_type", result: "not_applicable", reason: "no_type_declaration" };
  }
  let compared = 0;
  for (const [key, propDef] of Object.entries(propsSchema)) {
    const declared = declaredTypeOfProp(propDef);
    if (!declared) continue;
    if (!Object.hasOwn(resp, key)) continue;
    const actualVal = resp[key];
    if (actualVal === null || declared === "null") continue;
    const actual = jsonTypeOf(actualVal);
    compared++;
    if (!typesCompatible(declared, actual)) {
      // fail にするのは JSON Schema の type で宣言された型と違うときだけ。見本の値から推した型との違いは
      // 確かな証拠ではない（見本は型の宣言ではない）ので not_checked（売り手への冤罪を避ける・依頼主の方針 11/15）。
      if (fromExample || !isJsonSchemaProp(propDef)) {
        return {
          check: "declared_type",
          result: "not_checked",
          reason: "example_type_differs",
          detail: { key, declared, actual },
        };
      }
      return {
        check: "declared_type",
        result: "fail",
        reason: "type_differs",
        detail: { key, declared, actual },
      };
    }
  }
  if (compared === 0) {
    return { check: "declared_type", result: "not_applicable", reason: "no_overlapping_keys" };
  }
  return { check: "declared_type", result: "pass", reason: "types_match" };
}