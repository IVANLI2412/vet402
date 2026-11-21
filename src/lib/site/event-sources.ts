/** Maps first-party site event payloads (carried in `r`) to stored `source` labels. No PII. */

const KIND_RE = /^(429|503|timeout|other)$/;

export function homePasteErrorSource(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!KIND_RE.test(s)) return null;
  return s;
}

const VERDICT_SET = new Set(["ALLOW", "WARN", "BLOCK"]);

export function homeVerdictSource(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!VERDICT_SET.has(s)) return null;
  return s;
}

const HOME_CTA_TARGETS = new Set([
  "full_record",
  "copy_ts",
  "copy_curl",
  "copy_mcp_prompt",
  "try_example",
  "diagnose",
  "connect_agent",
  "record_badge",
]);

export function homeCtaSource(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!HOME_CTA_TARGETS.has(s)) return null;
  return s;
}

export function navCheckClickSource(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 64) return null;
  if (s.includes("lp-paste-url") || s === "/#lp-paste-url" || s === "/") return "paste_ui";
  if (s.includes("check-a-seller")) return "memo";
  return "other";
}

const PROMPT_ID_RE = /^[a-z0-9_]{1,32}$/i;

export function mcpPromptCopySource(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!PROMPT_ID_RE.test(s)) return null;
  return s.slice(0, 32);
}