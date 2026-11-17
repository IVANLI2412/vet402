import { sql } from "drizzle-orm";
import { canonicalNetworkId } from "@/lib/observatory/chains";
import { getDb, isDatabaseConfigured } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";

/** Network (CAIP-2) for a vet402 L1 purchase row, keyed by tx hash (case-insensitive). */
export async function lookupL1PurchaseNetwork(txHash: string): Promise<string | null> {
  const hash = txHash.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  if (!isDatabaseConfigured()) return null;
  const db = getDb();
  if (!db) return null;
  const rows = rowsOf<{ network: string }>(
    await db.execute(
      sql`SELECT network FROM x402_l1_purchases
          WHERE tx_hash IS NOT NULL AND network IS NOT NULL AND lower(tx_hash) = lower(${hash})
          LIMIT 1`,
    ),
  );
  const network = rows[0]?.network;
  if (typeof network !== "string" || !network.trim()) return null;
  return canonicalNetworkId(network.trim()) || null;
}