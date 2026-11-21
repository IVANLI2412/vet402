import { NextRequest } from "next/server";
import { handleJudgmentFile } from "@/lib/judgments/handler";
import { judgmentReaders } from "@/lib/judgments/daily-reader";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ file: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const file = (await context.params).file;
  return handleJudgmentFile(request, file, {
    ...judgmentReaders,
    now: () => new Date(),
  });
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
