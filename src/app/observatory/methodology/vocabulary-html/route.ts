import { methodologyVocabularyHtml } from "@/lib/observatory/vocabulary-html";

/** HTML fragment for §10 full definitions (loaded when the reader opens the fold). */
export async function GET() {
  return new Response(methodologyVocabularyHtml(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}