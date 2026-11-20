/**
 * Normalize a resource URL so spelling variants share one live-authorization slot.
 * Lowercases host, strips a trailing dot on the host, drops default :443, and drops a lone trailing `?`.
 */
export declare function normalizeResourceUrlForAuth(raw: string): string;
/**
 * Key for in-process duplicate-sign guard: prefer resolved resource_id, else normalized URL, plus payTo when known.
 */
export declare function authorizationResourceKey(input: {
    resourceUrl?: string;
    resourceId?: string | null;
    payTo?: string | null;
}): string | null;
