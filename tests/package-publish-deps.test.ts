import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dirname, "..");
const LINKED = /^(file:|link:|workspace:)/;

const PUBLISH_PACKAGES = ["sdk", "mcp-server", "middleware", "vet402"];

test("publish packages must not use file:, link:, or workspace: in dependencies or peerDependencies", () => {
  const packagesDir = join(ROOT, "packages");
  const offenders: string[] = [];
  for (const name of PUBLISH_PACKAGES) {
    const pkgDir = join(packagesDir, name);
    if (!statSync(pkgDir).isDirectory()) continue;
    const manifest = join(pkgDir, "package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const section of ["dependencies", "peerDependencies"] as const) {
      const block = pkg[section];
      if (!block) continue;
      for (const [dep, spec] of Object.entries(block)) {
        if (LINKED.test(spec.trim())) offenders.push(`${manifest} ${section}["${dep}"]=${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});