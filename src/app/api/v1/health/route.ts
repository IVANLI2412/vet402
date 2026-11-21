/**
 * Alias for GET /api/health — same liveness body and probes (uptime tools that
 * assume a /api/v1/* prefix).
 */
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export { GET } from "@/app/api/health/route";
export const dynamic = "force-dynamic";

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;