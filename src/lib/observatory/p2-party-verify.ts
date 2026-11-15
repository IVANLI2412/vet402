// ============================================================
// P2 の本人確認（3.4-P2-6）。送金先の鍵の署名、またはホストの DNS TXT。
// DNS TXT は未実装。未実装の経路を合格にしない。
// ============================================================
import { verifyMessage, type Hex } from "viem";
import { isValidIssuedAt, SIGNING_DOMAIN } from "@/lib/verify-message";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/;
const ISSUED_WINDOW_MS = 10 * 60_000;

export type P2PartyProof =
  | {
      kind: "payto_signature";
      wallet: string;
      signature: string;
      issued: string;
    }
  | {
      kind: "host_dns_txt";
      host: string;
      txt: string;
    };

export type P2PartyVerification =
  | { ok: true; method: "payto_signature" }
  | { ok: false; reason: "unverified" | "dns_txt_not_implemented" | "signature_expired" | "invalid_signature" };

export function p2PartyAccessMessage(input: { tradeId: string; party: "payer" | "seller"; issued: string }): string {
  return [
    `${SIGNING_DOMAIN} trade dispute view`,
    `domain: ${SIGNING_DOMAIN}`,
    `trade_id: ${input.tradeId.toLowerCase()}`,
    `party: ${input.party}`,
    `issued: ${input.issued}`,
    "This signature does not move funds.",
  ].join("\n");
}

export function issuedWithinFreshnessWindow(issued: string): boolean {
  if (!isValidIssuedAt(issued)) return false;
  return Math.abs(Date.now() - Date.parse(issued)) <= ISSUED_WINDOW_MS;
}

export async function verifyP2PartyAccess(
  party: "payer" | "seller",
  tradeId: string,
  proof: P2PartyProof,
  stored: { payer: string; receiver: string } | null,
): Promise<P2PartyVerification> {
  const raw = proof as unknown;
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "invalid_signature" };
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind !== "payto_signature" && kind !== "host_dns_txt") {
    return { ok: false, reason: "invalid_signature" };
  }
  if (kind === "host_dns_txt") {
    return { ok: false, reason: "dns_txt_not_implemented" };
  }
  const payto = raw as { kind: "payto_signature"; wallet: unknown; signature: unknown; issued: unknown };
  const walletStr = typeof payto.wallet === "string" ? payto.wallet : "";
  const signatureStr = typeof payto.signature === "string" ? payto.signature : "";
  const issuedStr = typeof payto.issued === "string" ? payto.issued : "";
  if (!SIGNATURE_RE.test(signatureStr) || !isValidIssuedAt(issuedStr)) {
    return { ok: false, reason: "unverified" };
  }
  if (!issuedWithinFreshnessWindow(issuedStr)) {
    return { ok: false, reason: "signature_expired" };
  }
  const wallet = walletStr.toLowerCase();
  if (!ADDRESS_RE.test(wallet)) {
    return { ok: false, reason: "unverified" };
  }
  let sigOk: boolean;
  try {
    sigOk = await verifyMessage({
      address: wallet as Hex,
      message: p2PartyAccessMessage({ tradeId, party, issued: issuedStr }),
      signature: signatureStr as Hex,
    });
  } catch {
    return { ok: false, reason: "unverified" };
  }
  if (!sigOk) {
    return { ok: false, reason: "unverified" };
  }
  if (!stored) {
    return { ok: false, reason: "unverified" };
  }
  const want = party === "payer" ? stored.payer.toLowerCase() : stored.receiver.toLowerCase();
  if (wallet !== want) {
    return { ok: false, reason: "unverified" };
  }
  return { ok: true, method: "payto_signature" };
}