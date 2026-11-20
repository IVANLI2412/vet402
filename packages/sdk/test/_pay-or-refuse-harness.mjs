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

/** /resolve が掲載に結べないとき（カタログ外の候補）。 */
export function resolveUnlistedStub(over = {}) {
  return {
    status: 200,
    body: {
      query: { kind: "url", value: "https://example.test/" },
      endpoints: [],
      not_found: { reason: "not_in_catalog", note: "test" },
      disclaimer: "test",
      ...over,
    },
  };
}

export function notFoundUncatalogued(over = {}) {
  return {
    status: 404,
    body: { error: "not_found", host_known: false, ...over },
  };
}

function decisionResponse(responses) {
  const key = Object.keys(responses).find((k) => k.includes("/decision") || k === "/decision");
  return key ? responses[key] : undefined;
}

function wantsUncataloguedResolve(responses) {
  const d = decisionResponse(responses);
  return (
    d?.status === 404 &&
    d?.body?.error === "not_found" &&
    d?.body?.host_known === false
  );
}

/**
 * Allowlist fetch with implicit /resolve when /decision (or other vet402 paths) are allowed.
 */
export function allowlistFetch(allowed, responses = {}) {
  const calls = [];
  const needResolve = allowed.some((a) => a.includes("/decision"));
  const hasResolve = allowed.some((a) => a.includes("/resolve")) || Object.keys(responses).some((k) => k.includes("/resolve"));
  const withResolve =
    !needResolve || hasResolve
      ? responses
      : {
          "/resolve": wantsUncataloguedResolve(responses) ? resolveUnlistedStub() : resolveStub(),
          ...responses,
        };
  const expanded = hasResolve || !needResolve ? allowed : ["/resolve", ...allowed];
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

/** Stub missing /resolve on an existing test fetch. */
export function withAutoResolve(fetchImpl, options = {}) {
  if (fetchImpl.__vet402ResolveWrapped) return fetchImpl;
  const unlisted = options.unlisted === true;
  const wrapped = async (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.includes("/resolve?q=")) {
      const stub = unlisted ? resolveUnlistedStub() : resolveStub();
      const body = JSON.stringify(stub.body);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetchImpl(input, init);
  };
  wrapped.__vet402ResolveWrapped = true;
  return wrapped;
}