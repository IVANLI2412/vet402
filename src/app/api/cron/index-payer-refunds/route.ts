import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import { indexPayerRefundsOrSkip } from "@/lib/sellers/refund-index";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lease = await acquireLeaseFailClosed("index-payer-refunds", 330);
  if (!lease.acquired && lease.reason === "unverified") {
    return NextResponse.json({ ok: false, error: "lease_unverified" }, { status: 503 });
  }
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  const deadlineAt = Date.now() + (maxDuration - 15) * 1000;
  try {
    const budgetMs = Math.max(5_000, deadlineAt - Date.now());
    const result = await indexPayerRefundsOrSkip({ budgetMs });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerErrorSafe("cron.index-payer-refunds", error);
    return NextResponse.json({ ok: false, error: "index_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
