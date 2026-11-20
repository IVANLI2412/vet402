/** Shared /resolve and ALLOW decision bodies for demo tests (SDK R3 gates). */
import {
  resolveStub,
  resolveUnlistedStub,
  defaultVerifiedTerms,
  decisionFreshness,
} from "../../../packages/sdk/test/_pay-or-refuse-harness.mjs";

export { resolveStub, resolveUnlistedStub, defaultVerifiedTerms, decisionFreshness };

/** カタログ外の /decision 404（host_known: false とセット）。 */
export const UNCATALOGUED_404_BODY = { error: "not_found", host_known: false };

/** `world.decision` があるときだけ掲載済み resolve、それ以外はカタログ外。 */
export function pickResolve(world = {}) {
  return world.decision !== undefined ? resolveStub() : resolveUnlistedStub();
}

export function handleResolveUrl(url, world = {}) {
  if (!String(url).includes("/resolve?q=")) return null;
  const stub = pickResolve(world);
  return { status: 200, body: stub.body };
}