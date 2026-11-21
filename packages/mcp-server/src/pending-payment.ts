/** Solana recent blockhash validity (seconds) used when FAILED leaves a live authorization. */
export const SOLANA_LIVE_AUTH_SECONDS = 90;

/** In-process guard: one live authorization per resource URL until validBefore. */
const live = new Map<string, { validBefore: number; nonce: string }>();
const pending = new Set<string>();

export function hasLiveAuthorization(resource: string): boolean {
  if (pending.has(resource)) return true;
  const row = live.get(resource);
  if (row === undefined) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now >= row.validBefore) {
    live.delete(resource);
    return false;
  }
  return true;
}

export function markPendingAuthorization(resource: string): void {
  pending.add(resource);
}

export function clearPendingAuthorization(resource: string): void {
  pending.delete(resource);
}

export function rememberLiveAuthorization(resource: string, validBefore: number, nonce: string): void {
  pending.delete(resource);
  live.set(resource, { validBefore, nonce });
}

export function clearLiveAuthorization(resource: string): void {
  pending.delete(resource);
  live.delete(resource);
}