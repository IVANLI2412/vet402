import { keylessDecisionPerMinute } from "@/lib/api/keyless-limits";

/**
 * The two paths in, shared by the front page. The package name, the calls and the
 * key-less limit follow keylessDecisionPerMinute() from src/lib/api/keyless-limits.ts:
 * createVouchClient, resolve, getDecision, pay when recommendation is ALLOW and degraded is false.
 */

export const DEV_INSTALL = "npm i @vet402/sdk";

export const DEV_CODE = `import { createVouchClient } from "@vet402/sdk"

const vet = createVouchClient({})
const { resource } = await vet.resolve("https://api.example.com/v1/quote")
const d = await vet.getDecision(resource!.resource_id)
// pay when d.recommendation is "ALLOW" and d.degraded is false`;

export const DEV_NOTE = `No key needed up to ${keylessDecisionPerMinute()} requests a minute.`;
