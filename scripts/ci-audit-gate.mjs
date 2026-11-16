#!/usr/bin/env node
import { spawnSync } from "node:child_process";

/** @type {{ id: string, reason: string, expires: string }[]} */
export const AUDIT_ALLOWLIST = [
  {
    id: "GHSA-mrhx-c7xc-m3w5",
    reason: "payment-path dependency, upgrade needs a separate review",
    expires: "2026-12-16",
  },
];

/** @param {unknown} report */
export function isNpmAuditJson(report) {
  return (
    report !== null &&
    typeof report === "object" &&
    ("auditReportVersion" in report || "vulnerabilities" in report || "metadata" in report)
  );
}

/**
 * @param {Record<string, { severity?: string, via?: unknown[] }>} vulns
 * @param {string} pkg
 * @param {Set<string>} [visiting]
 * @returns {string[]}
 */
export function resolveRootAdvisoryIds(vulns, pkg, visiting = new Set()) {
  const row = vulns[pkg];
  if (!row) return [`npm-audit:${pkg}:high`];

  const roots = new Set();
  for (const via of row.via ?? []) {
    if (typeof via === "string") {
      if (visiting.has(via)) continue;
      visiting.add(via);
      for (const id of resolveRootAdvisoryIds(vulns, via, visiting)) roots.add(id);
      visiting.delete(via);
      continue;
    }
    if (!via || typeof via !== "object") continue;
    if ("url" in via && typeof via.url === "string") {
      const m = /GHSA-[a-z0-9-]+/i.exec(via.url);
      if (m) roots.add(m[0]);
      else {
        const name = "name" in via && typeof via.name === "string" ? via.name : pkg;
        roots.add(`npm-audit:${name}:${row.severity ?? "high"}`);
      }
      continue;
    }
    const name = "name" in via && typeof via.name === "string" ? via.name : pkg;
    roots.add(`npm-audit:${name}:${row.severity ?? "high"}`);
  }

  if (!roots.size) roots.add(`npm-audit:${pkg}:${row.severity ?? "high"}`);
  return [...roots];
}

/**
 * @param {unknown} report npm audit --json
 * @param {string} today ISO date YYYY-MM-DD
 * @returns {{ ok: true } | { ok: false, blocked: string[], reason?: string }}
 */
export function gateAuditReport(report, today) {
  const vulns = /** @type {Record<string, { severity?: string, via?: unknown[] }>} */ (
    report && typeof report === "object" && "vulnerabilities" in report ? report.vulnerabilities : {}
  );

  const blocked = new Set();
  for (const [pkg, row] of Object.entries(vulns ?? {})) {
    if (row.severity !== "high" && row.severity !== "critical") continue;
    for (const id of resolveRootAdvisoryIds(vulns, pkg)) {
      const entry = AUDIT_ALLOWLIST.find((row) => row.id === id);
      if (!entry) {
        blocked.add(id);
        continue;
      }
      if (entry.expires < today) {
        return { ok: false, blocked: [id], reason: `allowlist expired for ${id} on ${entry.expires}` };
      }
    }
  }

  if (blocked.size) return { ok: false, blocked: [...blocked].sort() };
  return { ok: true };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** @returns {Promise<string>} */
async function readStdinPipe() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("").trim();
}

async function loadAuditReport() {
  if (!process.stdin.isTTY) {
    const stdout = await readStdinPipe();
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        console.error("ci-audit-gate: could not parse piped npm audit JSON");
        process.exit(1);
      }
    }
  }

  const child = spawnSync(
    "npm",
    ["audit", "--omit=dev", "--audit-level=high", "--json"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const stdout = child.stdout?.trim() ?? "";
  if (!stdout) {
    console.error("ci-audit-gate: npm audit produced no output", child.stderr?.trim() ?? "");
    process.exit(1);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    console.error("ci-audit-gate: could not parse npm audit JSON");
    process.exit(1);
  }
}

async function main() {
  const report = await loadAuditReport();
  if (!isNpmAuditJson(report)) {
    console.error("ci-audit-gate: stdout is not an npm audit report");
    process.exit(1);
  }

  const result = gateAuditReport(report, todayUtc());
  if (!result.ok) {
    if (result.reason) console.error(result.reason);
    console.error(
      "ci-audit-gate: disallowed high/critical advisories:",
      result.blocked.join(", "),
    );
    process.exit(1);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("ci-audit-gate.mjs")) {
  void main();
}