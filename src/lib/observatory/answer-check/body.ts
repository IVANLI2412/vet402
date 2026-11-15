import { BODY_HEAD_CHARS } from "@/lib/observatory/l2-check";
import type { StoredAnswer } from "./types";

/** 保存した bodyHead が本文の全部のときだけ全文を返す。 */
export function completeBodyOf(a: StoredAnswer): string | null {
  if (a.bodyIncomplete === true) return null;
  if (typeof a.bodyHead !== "string") return null;
  if (a.bodyHead.length >= BODY_HEAD_CHARS) return null;
  if (a.bodyBytes !== null && Buffer.byteLength(a.bodyHead, "utf8") !== a.bodyBytes) return null;
  return a.bodyHead;
}