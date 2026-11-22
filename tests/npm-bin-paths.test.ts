// npm 11.16 の publish は bin のパスが "./" で始まると「invalid」として黙って外す
// （2026-11-22 vet402@0.1.5 で npx vet402 が入らなかった）。全パッケージの bin を "dist/..." の形に固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("no package declares a bin path starting with ./", () => {
  const root = join(process.cwd(), "packages");
  let seen = 0;
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, "package.json");
    if (!existsSync(p)) continue;
    const bin = JSON.parse(readFileSync(p, "utf8")).bin;
    if (!bin) continue;
    const paths = typeof bin === "string" ? [bin] : Object.values(bin as Record<string, string>);
    for (const v of paths) {
      seen += 1;
      assert.ok(!v.startsWith("./"), `${dir}: bin ${v} starts with ./ and npm publish drops it`);
    }
  }
  assert.ok(seen >= 2, "expected the vet402 and mcp-server bins");
});
