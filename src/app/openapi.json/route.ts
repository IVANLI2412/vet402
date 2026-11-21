import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { load } = createRequire(import.meta.url)("js-yaml") as {
  load: (source: string) => unknown;
};

/**
 * JSON twin of docs/openapi.yaml for OpenAPI Generator and other tools that
 * default to .json. Canonical source remains docs/openapi.yaml.
 */
export const dynamic = "force-static";

export function GET() {
  const spec = load(readFileSync(join(process.cwd(), "docs", "openapi.yaml"), "utf8"));
  return Response.json(spec, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}