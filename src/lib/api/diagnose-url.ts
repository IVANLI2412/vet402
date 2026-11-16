import { SITE_URL } from "@/lib/site-url";

/** Live 402 probe URL for a seller endpoint (check reads records; diagnose hits the URL now). */
export function diagnoseUrlFor(catalogUrl: string): string {
  return `${SITE_URL}/api/v1/diagnose?url=${encodeURIComponent(catalogUrl)}`;
}