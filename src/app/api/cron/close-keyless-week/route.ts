import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { closeCompletedKeylessWeeks } from "@/lib/api/keyless-callers-close";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const result = await closeCompletedKeylessWeeks();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerErrorSafe("cron.close-keyless-week", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
