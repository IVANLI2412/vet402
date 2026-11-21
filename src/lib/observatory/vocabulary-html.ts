import { OBSERVATORY_VOCABULARY, VOCABULARY_GROUP_LABELS } from "@/lib/observatory/vocabulary";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** §10 definitions as an HTML fragment (methodology fold fetch). */
export function methodologyVocabularyHtml(): string {
  const groups = Object.keys(VOCABULARY_GROUP_LABELS) as (keyof typeof VOCABULARY_GROUP_LABELS)[];
  const parts: string[] = [];
  for (const group of groups) {
    parts.push(`<div class="mt-6"><p class="text-brand-deep">${esc(VOCABULARY_GROUP_LABELS[group])}</p><dl class="mt-2 max-w-[70ch]">`);
    for (const t of OBSERVATORY_VOCABULARY.filter((row) => row.group === group)) {
      parts.push(
        `<div class="mt-3"><dt id="term-${esc(t.term)}" class="text-brand-deep"><code>${esc(t.term)}</code></dt>` +
          `<dd class="doc-p mt-1">${esc(t.definition)}</dd></div>`,
      );
    }
    parts.push("</dl></div>");
  }
  return parts.join("");
}