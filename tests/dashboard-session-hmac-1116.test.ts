import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { __setDbForTests } from "@/lib/db/client";
import { createDashboardSession } from "@/lib/dashboard/session";

test("dashboard session tokens use HMAC-SHA256 with pepper", () => {
  const src = readFileSync("src/lib/dashboard/session.ts", "utf8");
  assert.match(src, /createHmac\("sha256"/);
  assert.match(src, /DASHBOARD_SESSION_PEPPER/);
  assert.doesNotMatch(src, /createHash\("sha256"\).*sessionSecret/s);
});

test("pepper changes the stored hash", () => {
  const token = "a".repeat(64);
  const h1 = createHmac("sha256", "pepper-a").update(token).digest("hex");
  const h2 = createHmac("sha256", "pepper-b").update(token).digest("hex");
  assert.notEqual(h1, h2);
});

const envSnapshot = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __setDbForTests(null);
});

test("production uses API_KEY_PEPPER when DASHBOARD_SESSION_PEPPER is unset", async () => {
  process.env.APP_ENV = "production";
  delete process.env.DASHBOARD_SESSION_PEPPER;
  process.env.API_KEY_PEPPER = "prod-api-key-pepper";
  delete process.env.DASHBOARD_SESSION_SECRET;
  let storedHash: string | undefined;
  __setDbForTests({
    delete: () => ({ where: async () => undefined }),
    insert: () => ({
      values: async (row: { tokenHash: string }) => {
        storedHash = row.tokenHash;
      },
    }),
  } as never);
  const token = await createDashboardSession("00000000-0000-0000-0000-000000000001");
  assert.equal(
    storedHash,
    createHmac("sha256", "prod-api-key-pepper").update(token).digest("hex"),
  );
});

test("production refuses legacy session secret when both peppers are unset", async () => {
  process.env.APP_ENV = "production";
  delete process.env.DASHBOARD_SESSION_PEPPER;
  delete process.env.API_KEY_PEPPER;
  process.env.DASHBOARD_SESSION_SECRET = "legacy-only";
  __setDbForTests({
    delete: () => ({ where: async () => undefined }),
    insert: () => ({ values: async () => undefined }),
  } as never);
  await assert.rejects(
    () => createDashboardSession("00000000-0000-0000-0000-000000000001"),
    /DASHBOARD_SESSION_PEPPER or API_KEY_PEPPER/,
  );
});

test("createDashboardSession stores only the HMAC hash, not the raw token", async () => {
  process.env.DASHBOARD_SESSION_PEPPER = "test-session-pepper";
  let storedHash: string | undefined;
  const storedRows: Record<string, unknown>[] = [];
  __setDbForTests({
    delete: () => ({ where: async () => undefined }),
    insert: () => ({
      values: async (row: { tokenHash: string; apiKeyId: string }) => {
        storedHash = row.tokenHash;
        storedRows.push(row);
      },
    }),
  } as never);
  const token = await createDashboardSession("00000000-0000-0000-0000-000000000001");
  assert.equal(storedRows.length, 1);
  assert.equal(storedHash, createHmac("sha256", "test-session-pepper").update(token).digest("hex"));
  assert.notEqual(storedHash, token);
  assert.equal((storedRows[0] as { tokenHash: string }).tokenHash, storedHash);
});