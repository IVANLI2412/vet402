// 鍵なしの支払い証明。本文の解読とチェーン読みは lib/payment-proof に置く。
import type { NextRequest } from "next/server";
import { handlePaymentProof } from "@/lib/payment-proof/handle";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(request: NextRequest): Promise<Response> {
  return handlePaymentProof(request);
}
const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
