/** Paid seller wait is capped at the EIP-3009 authorization window (same as @vet402/sdk). */
export const MAX_PAID_SELLER_WAIT_MS = 120_000;

const PAYMENT_HEADER_NAMES = ["payment-signature", "x-payment"] as const;

/** vet402 API ルートの origin（boundedFetch の照合に使う）。 */
export function originOfVet402ApiRoot(apiRoot: string): string {
  try {
    return new URL(apiRoot.includes("://") ? apiRoot : `https://${apiRoot}`).origin;
  } catch {
    return apiRoot;
  }
}

/** vet402 へだけ AbortSignal.timeout を付ける fetch。 */
export function vet402BoundedFetch(apiRoot: string, timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  const apiOrigin = originOfVet402ApiRoot(apiRoot);
  return (url, init) => {
    const target = String(url);
    let isVet402 = target.startsWith(apiRoot);
    if (!isVet402) {
      try {
        isVet402 = new URL(target).origin === apiOrigin;
      } catch {
        isVet402 = false;
      }
    }
    if (!isVet402) {
      return baseFetch(url, init);
    }
    return baseFetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  };
}

function hasPaidPaymentHeader(headers: Headers): boolean {
  return PAYMENT_HEADER_NAMES.some((name) => headers.has(name));
}

function fromBase64(raw: string): string {
  return Buffer.from(raw, "base64").toString("utf8");
}

/** validBefore (unix seconds) from a signed PAYMENT-SIGNATURE / X-PAYMENT header, if readable. */
export function validBeforeSecFromPaymentHeaders(headers: Headers): number | null {
  for (const name of PAYMENT_HEADER_NAMES) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      const body = JSON.parse(fromBase64(raw)) as Record<string, unknown>;
      const payload = body.payload as Record<string, unknown> | undefined;
      const auth = payload?.authorization as Record<string, unknown> | undefined;
      const vb = auth?.validBefore;
      if (typeof vb === "string" || typeof vb === "number") {
        const n = Number(vb);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    } catch {
      // not a payment header we can read
    }
  }
  return null;
}

/** Wall-clock wait until validBefore, capped at {@link MAX_PAID_SELLER_WAIT_MS}. */
export function paidSellerWaitMs(validBeforeSec: number | null, nowMs: number): number {
  if (validBeforeSec === null) return MAX_PAID_SELLER_WAIT_MS;
  const remaining = validBeforeSec * 1000 - nowMs;
  if (remaining <= 0) return 1;
  return Math.min(MAX_PAID_SELLER_WAIT_MS, Math.floor(remaining));
}

function operationTimedOut(): DOMException {
  return new DOMException("The operation timed out", "TimeoutError");
}

/** Schedules abort so a hung seller fetch cannot leave the MCP tool call open (Node keeps the loop alive). */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(operationTimedOut());
  }, ms);
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any(live);
  const controller = new AbortController();
  const onAbort = (): void => {
    for (const s of live) s.removeEventListener("abort", onAbort);
    const aborted = live.find((s) => s.aborted);
    controller.abort(aborted?.reason ?? new DOMException("The operation was aborted", "AbortError"));
  };
  for (const s of live) {
    if (s.aborted) {
      onAbort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * vet402 API reads use `vet402TimeoutMs`. Paid seller retries wait until the signed
 * authorization's validBefore (capped at 120 s) so a silent seller cannot hang the tool call.
 */
export function createMcpBoundedFetch(
  apiRoot: string,
  vet402TimeoutMs: number,
  baseFetch: typeof fetch = fetch,
  nowMs: () => number = () => Date.now(),
): typeof fetch {
  const vet402Fetch = vet402BoundedFetch(apiRoot, vet402TimeoutMs, baseFetch);
  return (url, init) => {
    const headers = new Headers(init?.headers);
    if (!hasPaidPaymentHeader(headers)) {
      return vet402Fetch(url, init);
    }
    const waitMs = paidSellerWaitMs(validBeforeSecFromPaymentHeaders(headers), nowMs());
    const timed = timeoutSignal(waitMs);
    const caller = init?.signal ?? undefined;
    const signal = caller === undefined ? timed : combineAbortSignals([caller, timed]);
    return vet402Fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) });
  };
}