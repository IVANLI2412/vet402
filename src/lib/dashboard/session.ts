import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { isProduction, secureCookiesEnabled } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { dashboardSessions } from "@/lib/db/schema";

export const DASHBOARD_COOKIE = "vouch_dash";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Legacy sha256(secret:token) lookups stop at this instant (UTC). */
export const LEGACY_DASHBOARD_SESSION_HASH_UNTIL = new Date("2026-12-16T00:00:00.000Z");

function sessionPepper(): string {
  const dedicated = process.env.DASHBOARD_SESSION_PEPPER?.trim();
  if (dedicated) return dedicated;
  const apiKey = process.env.API_KEY_PEPPER?.trim();
  if (apiKey) return apiKey;
  if (isProduction()) {
    throw new Error(
      "DASHBOARD_SESSION_PEPPER or API_KEY_PEPPER is required in production",
    );
  }
  const legacy = process.env.DASHBOARD_SESSION_SECRET?.trim();
  if (legacy) return legacy;
  return "dev_dashboard_session_pepper_change_me";
}

function legacySessionSecret(): string {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (secret) return secret;
  if (isProduction()) {
    throw new Error("DASHBOARD_SESSION_SECRET is required in production");
  }
  return "dev_dashboard_secret_change_me";
}

function hashSessionToken(token: string): string {
  return createHmac("sha256", sessionPepper()).update(token).digest("hex");
}

function hashLegacySessionToken(token: string): string {
  return createHash("sha256").update(`${legacySessionSecret()}:${token}`).digest("hex");
}

function legacySessionHashEnabled(now: Date = new Date()): boolean {
  return now.getTime() < LEGACY_DASHBOARD_SESSION_HASH_UNTIL.getTime();
}

export async function createDashboardSession(apiKeyId: string): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  await db.delete(dashboardSessions).where(eq(dashboardSessions.apiKeyId, apiKeyId));

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(dashboardSessions).values({
    tokenHash: hashSessionToken(token),
    apiKeyId,
    expiresAt,
  });

  return token;
}

export async function resolveDashboardSession(
  token: string | undefined,
): Promise<{ apiKeyId: string } | null> {
  if (!token) return null;

  const db = getDb();
  if (!db) return null;

  const now = new Date();
  const hmacHash = hashSessionToken(token);

  const rows = await db
    .select({ apiKeyId: dashboardSessions.apiKeyId })
    .from(dashboardSessions)
    .where(and(eq(dashboardSessions.tokenHash, hmacHash), gt(dashboardSessions.expiresAt, now)))
    .limit(1);

  if (rows[0]) return { apiKeyId: rows[0].apiKeyId };

  if (!legacySessionHashEnabled(now)) return null;

  const legacyHash = hashLegacySessionToken(token);
  const legacyRows = await db
    .select({ apiKeyId: dashboardSessions.apiKeyId })
    .from(dashboardSessions)
    .where(and(eq(dashboardSessions.tokenHash, legacyHash), gt(dashboardSessions.expiresAt, now)))
    .limit(1);

  if (!legacyRows[0]) return null;

  await db.execute(sql`
    UPDATE dashboard_sessions
    SET token_hash = ${hmacHash}::text
    WHERE token_hash = ${legacyHash}::text
      AND expires_at > ${now.toISOString()}::timestamptz
  `);

  return { apiKeyId: legacyRows[0].apiKeyId };
}

export async function deleteDashboardSession(token: string | undefined): Promise<void> {
  if (!token) return;

  const db = getDb();
  if (!db) return;

  await db
    .delete(dashboardSessions)
    .where(eq(dashboardSessions.tokenHash, hashSessionToken(token)));
}

export async function deleteDashboardSessionsForApiKey(apiKeyId: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  await db.delete(dashboardSessions).where(eq(dashboardSessions.apiKeyId, apiKeyId));
}

export async function getDashboardSessionFromCookies(): Promise<{ apiKeyId: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(DASHBOARD_COOKIE)?.value;
  return resolveDashboardSession(token);
}

export function dashboardCookieOptions(token: string) {
  return {
    name: DASHBOARD_COOKIE,
    value: token,
    httpOnly: true,
    secure: secureCookiesEnabled(),
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}
