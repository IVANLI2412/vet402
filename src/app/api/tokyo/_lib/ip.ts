// 連打の間隔（20 秒）と IP ごとの1日の上限に使う呼び手の鍵。IP そのものは保存しない（sha256 の先頭 16 桁だけ）。
// 既存の client-ip（src/lib/api）は設定のモジュールを連れてきて env 名が増えるので使わない（W01）。
// Vercel では x-vercel-forwarded-for をプラットフォームが上書きする。無ければ全員が1つの鍵を共有する
// （締める側に倒れる。ヘッダの無い呼び手が何人いても、合わせて IP 1つぶんしか押せない。
// 本番の Vercel では必ず付くので、無いのは Vercel の外から来た要求だけ）。
// 間隔は関門に数えない。本当の関門は1日の上限（全体と IP ごと）と残高の床。
import { createHash, createHmac, hkdfSync } from "node:crypto";

function tokyoIpKey(): Buffer | null {
  const material = process.env.API_KEY_PEPPER?.trim();
  if (!material) return null;
  return Buffer.from(hkdfSync("sha256", material, "", "vet402/tokyo/caller-key/v1", 32));
}

function legacyCallerDigest(raw: string, label: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function callerKey(request: Request): string {
  const raw = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = tokyoIpKey();
  if (!key) return legacyCallerDigest(raw, "caller");
  return createHmac("sha256", key).update(`caller|${raw}`).digest("hex").slice(0, 16);
}

/** IPv6 は /64 に丸める（1 回線に /64 が配られ、下位は利用者が回せる）。IPv4 射影は IPv4。 */
function networkOf(raw: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(":")) return raw;
  const [head = "", tail = ""] = raw.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = raw.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** 回数の枠（rate-limit.ts）の鍵。callerKey と同じく IP そのものは保存しない。 */
export function callerNetworkKey(request: Request): string {
  const raw = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = tokyoIpKey();
  const net = networkOf(raw);
  if (!key) return legacyCallerDigest(net, "network");
  return createHmac("sha256", key).update(`network|${net}`).digest("hex").slice(0, 16);
}
