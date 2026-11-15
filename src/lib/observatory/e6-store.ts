// ============================================================
// 旧 E6 メモリ（E5 seller-edge 試験用）。P2 の争い記録は trade-dispute-store。
// ============================================================
import {
  mergeE6Record,
  type E6Record,
} from "@/lib/observatory/e6-record";

export type E6Store = {
  get(purchaseId: string): Promise<E6Record | null>;
  put(record: E6Record): Promise<void>;
};

let activeStore: E6Store | null = null;
let defaultMemoryStore: (E6Store & { rows: Map<string, E6Record> }) | null = null;

function ensureDefaultStore(): E6Store & { rows: Map<string, E6Record> } {
  if (!defaultMemoryStore) {
    defaultMemoryStore = memoryE6Store();
  }
  return defaultMemoryStore;
}

export function getE6Store(): E6Store | null {
  return activeStore ?? ensureDefaultStore();
}

export function setE6StoreForTests(store: E6Store | null): void {
  activeStore = store;
}

export function memoryE6Store(seed: Record<string, E6Record> = {}): E6Store & { rows: Map<string, E6Record> } {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    async get(purchaseId: string) {
      const r = rows.get(purchaseId);
      return r ? structuredClone(r) : null;
    },
    async put(record: E6Record) {
      rows.set(record.purchaseId, structuredClone(record));
    },
  };
}
