import { NextRequest } from "next/server";
export { handleCheck } from "@/lib/api/check-handler";
import { handleKeylessCheckRoute } from "@/lib/api/keyless-check-route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  return handleKeylessCheckRoute(request, "rest:check");
}