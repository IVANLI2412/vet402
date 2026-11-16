import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_ALLOWLIST, gateAuditReport, isNpmAuditJson } from "../scripts/ci-audit-gate.mjs";

const GATE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/ci-audit-gate.mjs");

const FIXTURE_ALLOWLIST = [
  { id: "GHSA-mrhx-c7xc-m3w5", reason: "fixture: dated exception", expires: "2026-12-16" },
];
const ALLOWED_ID = FIXTURE_ALLOWLIST[0]!.id;

test("the shipped allowlist is empty (no standing high exceptions)", () => {
  assert.deepEqual(AUDIT_ALLOWLIST, []);
});

const SAMPLE = {
  vulnerabilities: {
    zod: {
      severity: "high",
      via: [{ url: `https://github.com/advisories/${ALLOWED_ID}`, severity: "high" }],
    },
  },
};

test("allowed high advisory passes before expiry", () => {
  const result = gateAuditReport(SAMPLE, "2026-12-01", FIXTURE_ALLOWLIST);
  assert.equal(result.ok, true);
});

test("allowed high advisory fails after expiry", () => {
  const result = gateAuditReport(SAMPLE, "2026-12-17", FIXTURE_ALLOWLIST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reason?.includes("expired"));
});

test("isNpmAuditJson rejects empty object", () => {
  assert.equal(isNpmAuditJson({}), false);
  assert.equal(isNpmAuditJson({ auditReportVersion: 2, vulnerabilities: {} }), true);
});

test("high/critical without GHSA url still blocks", () => {
  const report = {
    vulnerabilities: {
      evil: { severity: "high", via: [{ source: 999, name: "evil", dependency: "evil", title: "x" }] },
    },
  };
  const result = gateAuditReport(report, "2026-12-01", FIXTURE_ALLOWLIST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.blocked, ["npm-audit:evil:high"]);
});

test("unexpected high advisory fails", () => {
  const report = {
    vulnerabilities: {
      pkg: {
        severity: "critical",
        via: [{ url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz", severity: "critical" }],
      },
    },
  };
  const result = gateAuditReport(report, "2026-12-01", FIXTURE_ALLOWLIST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.blocked, ["GHSA-xxxx-yyyy-zzzz"]);
});

test("derived high/critical passes when all root advisories are allowlisted", () => {
  const report = {
    vulnerabilities: {
      zod: {
        severity: "high",
        via: [{ url: `https://github.com/advisories/${ALLOWED_ID}`, severity: "high" }],
      },
      "@x402/core": { severity: "high", via: ["zod"] },
      "@x402/stellar": { severity: "high", via: ["@x402/core"] },
    },
  };
  const result = gateAuditReport(report, "2026-12-01", FIXTURE_ALLOWLIST);
  assert.equal(result.ok, true);
});

test("piped npm audit JSON via child stdin exits 0", async () => {
  const payload = JSON.stringify({
    auditReportVersion: 2,
    // The shipped allowlist is empty, so a clean report is what must pass through the pipe.
    vulnerabilities: {},
  });

  const { exitCode, stderr } = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [GATE_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });

  assert.equal(exitCode, 0, stderr.trim() || undefined);
});

test("derived high/critical fails when a root advisory is not allowlisted", () => {
  const report = {
    vulnerabilities: {
      rootpkg: {
        severity: "high",
        via: [{ url: "https://github.com/advisories/GHSA-bbbb-cccc-dddd", severity: "high" }],
      },
      derived: { severity: "high", via: ["rootpkg"] },
    },
  };
  const result = gateAuditReport(report, "2026-12-01", FIXTURE_ALLOWLIST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.blocked, ["GHSA-bbbb-cccc-dddd"]);
});