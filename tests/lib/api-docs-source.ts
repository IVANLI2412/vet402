import { readFileSync } from "node:fs";

/** API reference prose split across page.tsx, deferred sections, and endpoint cards (UX3–UX4). */
export function apiDocsPageText(): string {
  return (
    readFileSync("src/app/docs/api/page.tsx", "utf8") +
    readFileSync("src/components/docs/ApiDocsRest.tsx", "utf8") +
    readFileSync("src/lib/docs/api-endpoints-data.tsx", "utf8")
  );
}