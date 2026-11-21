import { NextRequest, NextResponse } from "next/server";
import { authorizeDashboardRequest } from "@/lib/dashboard/auth";
import { getDashboardOverview } from "@/lib/dashboard/data";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

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
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
