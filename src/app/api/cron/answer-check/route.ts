import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { runAnswerCheckCron } from "@/lib/observatory/answer-check/cron";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 250);
  const budgetMs = Number(request.nextUrl.searchParams.get("budgetMs") ?? 45_000);
  try {
    const result = await runAnswerCheckCron({
      batchSize: Math.min(500, Math.max(1, limit)),
      budgetMs: Math.min(55_000, Math.max(5_000, budgetMs)),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerErrorSafe("cron.answer-check", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
