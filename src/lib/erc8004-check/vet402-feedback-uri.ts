import { OWN_ORIGINS } from "@/lib/decision/lookup-caller";

function configuredSiteOrigins(): ReadonlySet<string> {
  const origins = new Set(OWN_ORIGINS);
  const configured = process.env.VET402_SITE_ORIGIN?.trim();
  if (configured) {
    try {
      origins.add(new URL(configured).origin);
    } catch {
      origins.add(configured.replace(/\/$/, ""));
    }
  }
  return origins;
}

/** Weekly attest URIs and other feedback hosted on vet402's own site. */
export function isVet402HostedFeedbackUri(feedbackUri: string): boolean {
  const trimmed = feedbackUri.trim();
  if (!trimmed.startsWith("https://")) return false;
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    return false;
  }
  return configuredSiteOrigins().has(origin);
}