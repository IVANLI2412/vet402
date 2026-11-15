import { logServerErrorSafe } from "@/lib/util/log-safe";
import { getSellerRefundStatsCached } from "@/lib/sellers/cached";
import type { PayToRefund, RefundStats } from "@/lib/sellers/refunds";

function formatUtc(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi} UTC`;
}

export function formatRefundUsdcAmount(units: string): string {
  let amount: bigint;
  try {
    amount = BigInt(units);
  } catch {
    return `${units} USDC`;
  }
  const scale = 1_000_000n;
  const whole = amount / scale;
  const frac = amount % scale;
  if (frac === 0n) return `${whole} USDC`;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} USDC`;
}

function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function percent(rate: number | null): string {
  return rate === null ? "0" : (rate * 100).toFixed(2);
}

/** 1つの payTo の文（payTo 単位の数字・ホストに振り分けない）。 */
export function payToRefundLines(r: PayToRefund): string[] {
  const lines: string[] = [];
  const who = `payTo ${shortAddress(r.pay_to)}`;
  if (r.listings_sharing > 1) {
    lines.push(
      `This ${who} is shared by ${r.listings_sharing} listings. The numbers below are for the payTo as a whole, not for this listing alone.`,
    );
  }
  if (r.refund_rate === null) {
    lines.push(`No settled Base purchase paid to this ${who} is in the refund count yet, so there is no refund rate to show.`);
  } else {
    lines.push(
      `${formatRefundUsdcAmount(r.refunded_units)} of the ${formatRefundUsdcAmount(r.paid_units)} that vet402 paid to this ${who} on ${r.failures_counted} purchases in the refund count came back (${percent(r.refund_rate)}%), in ${r.refund_transfers} refund transfers.`,
    );
  }
  if (r.failures_window_open > 0) {
    lines.push(
      `${r.failures_window_open} settled purchases on the seller's side paid to this ${who} are less than 30 days old or not read yet, so they are not in the count.`,
    );
  }
  return lines;
}

/** 節の共通の文（定義）。 */
export function refundDefinitionLines(stats: RefundStats): string[] {
  const lines = [
    "The refund count takes settled purchases by the vet402 Base payer that this page puts on the seller's side and whose 30 days vet402 has read. Rows held for judgment (any settled 4xx, a 202, an unconfirmed payment) are not in this count, even when this page puts a settled 4xx on the seller's side. A payment that never settled, such as a voided hold, is not in this count.",
    "vet402 adds up the USDC sent back from the payTo to the vet402 Base payer within 30 days after one of those purchases, counts each transfer once, and caps the sum at the amount paid. The rate is the amount that came back divided by the amount paid. A refund transfer is not tied to one purchase.",
  ];
  if (stats.read_through) lines.push(`Read through ${formatUtc(stats.read_through)}.`);
  if (stats.failures_not_read > 0) {
    lines.push(`${stats.failures_not_read} purchases on other networks are not read yet and are not in the count.`);
  }
  return lines;
}

/** 試験用: 節の全ての文。 */
export function refundSectionLines(stats: RefundStats): string[] {
  return [...stats.pay_tos.flatMap(payToRefundLines), ...refundDefinitionLines(stats)];
}

export default async function SellerRefundSection({ host }: { host: string }) {
  let stats: RefundStats | null = null;
  try {
    stats = await getSellerRefundStatsCached(host);
  } catch (error) {
    // A missing table already reads as null. Anything else is logged so a hidden section has a reason.
    logServerErrorSafe("sellers.refund-section", error);
    return null;
  }
  if (!stats) return null;

  if (stats.pay_tos.length === 0) return null;
  return (
    <section className="mx-auto mt-8 max-w-[70ch]">
      <h2 className="doc-h2">Refunds after a seller-side failure, by payTo</h2>
      {stats.pay_tos.map((r) => (
        <div key={r.pay_to} className="mt-3">
          {payToRefundLines(r).map((line) => (
            <p key={line} className="doc-p">
              {line}
            </p>
          ))}
          {r.refund_txs.length > 0 && (
            <ul className="mt-2 list-disc pl-6">
              {r.refund_txs.map((tx, i) => (
                <li key={`${tx.tx_hash}:${i}`}>
                  <a className="underline" href={`https://basescan.org/tx/${tx.tx_hash}`} rel="noopener noreferrer">
                    {tx.tx_hash.slice(0, 10)}…
                  </a>
                  {" · "}
                  {formatRefundUsdcAmount(tx.amount_units)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {refundDefinitionLines(stats).map((line) => (
        <p key={line} className="doc-p">
          {line}
        </p>
      ))}
    </section>
  );
}
