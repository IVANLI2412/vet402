// POST /api/tokyo/mutate — 審査員ボタン。seller-d.eth の x402-offer の amount を 10000 → 10001 に1文字だけ変える。
// 鍵と関門は PLAN_v4.3 §3.7.1（W01〜W06）。中身は ../_lib/button.ts の handleMutate。
import { handleMutate } from "../_lib/button";
import { realButtonDeps } from "../_lib/deps";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleMutate(request, realButtonDeps());
}
const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
