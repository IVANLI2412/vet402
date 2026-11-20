/** Shared stubs for payOrRefuse tests after /resolve became mandatory. */

export const RESOURCE_ID = "a".repeat(64);
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function decisionFreshness() {
  const now = Date.now();
  return {
    scoredAt: new Date(now).toISOString(),
    cacheExpiresAt: new Date(now + 300_000).toISOString(),
  };
}

export function defaultVerifiedTerms(
  payTo,
  amount = "20000",
  asset = BASE_USDC,
  network = "eip155:8453",
  scheme = "exact",
) {
  return {
    pay_to: payTo,
    asset,
    amount,
    network,
    scheme,
  };
}

export function resolveStub(over = {}) {
  return {
    status: 200,
    body: {
      resource: {
        resource_id: RESOURCE_ID,
        ...over,
      },
    },
  };
}

/**
 * Allowlist fetch with implicit /resolve when /decision (or other vet402 paths) are allowed.
 */
export function allowlistFetch(allowed, responses = {}) {
  const calls = [];
  const withResolve =
    allowed.some((a) => a.includes("/resolve")) || !allowed.some((a) => a.includes("/decision"))
      ? responses
      : { "/resolve": resolveStub(), ...responses };
  const expanded = allowed.some((a) => a.includes("/resolve")) ? allowed : ["/resolve", ...allowed];
  return {
    calls,
    fetch: async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (!expanded.some((a) => u.includes(a))) {
        throw new Error(`forbidden call in refuse path: ${u}`);
      }
      let r = withResolve[Object.keys(withResolve).find((k) => u.includes(k))];
      if (typeof r === "function") r = r(u, init);
      if (!r) throw new Error(`no stub for ${u}`);
      return {
        ok: r.status < 400,
        status: r.status,
        json: async () => r.body,
        headers: new Map(Object.entries(r.headers ?? {})),
      };
    },
  };
}