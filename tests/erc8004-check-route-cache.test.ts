// whitehat-04: CDN に載せる 200 には呼び手ごとの RateLimit-Remaining を混ぜない。未知クエリは 400。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

test("erc8004 check rejects unknown query parameters", () => {
  const route = readFileSync(join(ROOT, "src/app/api/v1/erc8004/check/route.ts"), "utf8");
  assert.ok(route.includes("rejectUnknownQuery"));
});

test("erc8004 check 200 spreads cacheHeaders only", () => {
  const route = readFileSync(join(ROOT, "src/app/api/v1/erc8004/check/route.ts"), "utf8");
  const okBlock = route.slice(route.lastIndexOf("status: 200"), route.lastIndexOf("status: 200") + 400);
  assert.ok(okBlock.includes("...gate.cacheHeaders"));
  assert.ok(!okBlock.includes("...gate.headers"));
});

function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRoutes(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

test("routes with s-maxage do not emit RateLimit-Remaining on cacheable responses", () => {
  const bad: string[] = [];
  for (const file of walkRoutes(join(ROOT, "src/app/api"))) {
    const src = readFileSync(file, "utf8");
    for (const block of src.split("NextResponse.json").slice(1)) {
      const head = block.slice(0, 600);
      if (!/s-maxage/.test(head)) continue;
      if (/RateLimit-Remaining|\.headers,\s*\.\.\.(gate\.)?headers|perCallerRlHeaders/.test(head)) {
        bad.push(file.replace(ROOT + "/", ""));
        break;
      }
    }
  }
  assert.deepEqual(bad, [], `cacheable responses carrying per-caller RL: ${bad.join(", ")}`);
});