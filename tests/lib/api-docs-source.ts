import { readFileSync } from "node:fs";

/** API reference prose split across page.tsx and the deferred endpoint cards module (UX3). */
export function apiDocsPageText(): string {
  return (
    readFileSync("src/app/docs/api/page.tsx", "utf8") +
    readFileSync("src/lib/docs/api-endpoints-data.tsx", "utf8")
  );
}