import { keylessDecisionPerMinute } from "@/lib/api/keyless-limits";

/**
 * The two paths in, shared by the front page. The package name, the calls and the
 * key-less limit follow keylessDecisionPerMinute() from src/lib/api/keyless-limits.ts:
 * createVouchClient, resolve, getDecision, pay when recommendation is ALLOW and degraded is false.
 */

export const DEV_INSTALL = "npm install vet402";

export const DEV_CODE = `import { check } from "vet402"

const r = await check("https://llm.gedx402.com/v1/chat/code")
// pay with payOrRefuse from vet402/buyer when r.recommendation is "ALLOW"`;

export const DEV_NOTE = `No key needed up to ${keylessDecisionPerMinute()} requests a minute.`;
