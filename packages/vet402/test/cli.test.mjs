// npx vet402 check <url>: exit codes, the printed lines, and usage errors. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exitCodeOf, render, main } from "../dist/cli.js";

const found = (recommendation) => ({
  recommendation,
  reasonCodes: ["l1_delivered"],
  verifiedTerms: null,
  resourceId: "r1",
  evidenceUrl: "https://vet402.com/observatory/e/x",
  retrievedAt: "2026-11-22T00:00:00.000Z",
  scoredAt: "2026-11-22T00:00:00.000Z",
});

test("exit codes: ALLOW 0, BLOCK 1, WARN and UNKNOWN 2", () => {
  assert.equal(exitCodeOf(found("ALLOW")), 0);
  assert.equal(exitCodeOf(found("BLOCK")), 1);
  assert.equal(exitCodeOf(found("WARN")), 2);
  assert.equal(exitCodeOf({ recommendation: "UNKNOWN", reason: "not on record" }), 2);
});

test("render prints the verdict, reasons and the public record", () => {
  const s = render("https://a.example/x", found("BLOCK"));
  assert.match(s, /^BLOCK  https:\/\/a\.example\/x/);
  assert.match(s, /reasons: l1_delivered/);
  assert.match(s, /record: https:\/\/vet402\.com\/observatory\/e\/x/);
});

test("usage errors exit 3 and print usage", async () => {
  const sink = () => { let t = ""; return { write: (s) => { t += s; return true; }, get text() { return t; } }; };
  for (const argv of [[], ["check"], ["nope", "https://a.example"], ["check", "not a url"]]) {
    const out = sink(), err = sink();
    assert.equal(await main(argv, out, err), 3, JSON.stringify(argv));
    assert.match(err.text, /usage: npx vet402 check <url>/);
  }
});

test("package.json declares the vet402 bin and the built file starts with a shebang", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.bin, { vet402: "dist/cli.js" });
  assert.match(readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8"), /^#!\/usr\/bin\/env node\n/);
});
