import type { PlaygroundCandidate } from "./playground-client";

/** 初回 Run は ensureCatalog が返した先頭 id。2 回目以降は state の selected。 */
export function playgroundProbeEndpointId(
  hadCatalogInState: boolean,
  selected: string,
  stateCandidates: PlaygroundCandidate[],
  loadedCandidates: PlaygroundCandidate[],
): string | null {
  if (hadCatalogInState) return selected || stateCandidates[0]?.id || null;
  return loadedCandidates[0]?.id || null;
}