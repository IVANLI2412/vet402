import { NextRequest, NextResponse } from "next/server";
import { authorizeDashboardRequest } from "@/lib/dashboard/auth";
import { getDashboardOverview } from "@/lib/dashboard/data";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export async function GET(request: NextRequest) {
  const auth = await authorizeDashboardRequest(request);
  if (!auth.ok) return auth.error;

  try {
    const overview = await getDashboardOverview(auth.ctx.apiKeyId);
    return NextResponse.json(overview);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
