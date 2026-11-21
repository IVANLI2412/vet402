// The judge's path installs @vet402/sdk from vendor/vet402-sdk-<v>.tgz (a clean clone has no root node_modules,
// so packages/sdk cannot find viem). This fails whenever the tarball drifts from packages/sdk/dist:
// re-run `(cd packages/sdk && npm pack --pack-destination ../../vendor)` after any SDK change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after as __tmpAfter } from "node:test";
import { rmSync as __tmpRm } from "node:fs";
const __tmpDirs = [];
const __tmp = (d) => {
  __tmpDirs.push(d);
  return d;
};
// 2026-11-21: temp dirs were never removed (a 118MB fixture filled the disk). Remove them after this file.
__tmpAfter(() => {
  for (const d of __tmpDirs) __tmpRm(d, { recursive: true, force: true });
});


const ROOT = join(import.meta.dirname, '..', '..', '..');

test('vendor SDK tarball matches packages/sdk (version and every dist file byte for byte)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/sdk/package.json'), 'utf8'));
  const tgz = join(ROOT, 'vendor', `vet402-sdk-${pkg.version}.tgz`);
  const out = __tmp(mkdtempSync(join(tmpdir(), 'vendor-sdk-')));
  execFileSync('tar', ['xzf', tgz, '-C', out]);
  const packed = join(out, 'package');
  assert.equal(JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8')).version, pkg.version);
  const dist = readdirSync(join(ROOT, 'packages/sdk/dist')).sort();
  assert.deepEqual(readdirSync(join(packed, 'dist')).sort(), dist, 'file list differs');
  for (const f of dist) {
    assert.ok(readFileSync(join(packed, 'dist', f)).equals(readFileSync(join(ROOT, 'packages/sdk/dist', f))), `dist/${f} differs — re-pack the SDK`);
  }
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(demo.devDependencies['@vet402/sdk'], `file:../../vendor/vet402-sdk-${pkg.version}.tgz`);
});
