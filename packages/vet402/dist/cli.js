#!/usr/bin/env node
// npx vet402 check <url> [--json]
// Asks vet402 whether it has seen this x402 URL deliver when paid. No key, no wallet, no payment.
// Exit code: 0 ALLOW, 1 BLOCK, 2 WARN or UNKNOWN, 3 usage or network error.
import { check } from "./check.js";
const USAGE = "usage: npx vet402 check <url> [--json]";
export function exitCodeOf(r) {
    if (r.recommendation === "ALLOW")
        return 0;
    if (r.recommendation === "BLOCK")
        return 1;
    return 2;
}
export function render(url, r) {
    if (r.recommendation === "UNKNOWN")
        return `UNKNOWN  ${url}\n  ${r.reason}`;
    const lines = [`${r.recommendation}  ${url}`];
    if (r.reasonCodes.length > 0)
        lines.push(`  reasons: ${r.reasonCodes.join(", ")}`);
    if (r.verifiedTerms) {
        const t = r.verifiedTerms;
        lines.push(`  last delivered purchase: pay_to ${t.pay_to} on ${t.network}, ${t.amount} atomic (${t.verified_at})`);
    }
    lines.push(`  record: ${r.evidenceUrl}`);
    return lines.join("\n");
}
export async function main(argv, out = process.stdout, err = process.stderr) {
    const args = argv.filter((a) => a !== "--json");
    const json = argv.includes("--json");
    if (args[0] !== "check" || args.length !== 2) {
        err.write(`${USAGE}\n`);
        return 3;
    }
    const url = args[1];
    try {
        new URL(url);
    }
    catch {
        err.write(`vet402: not a URL: ${url}\n${USAGE}\n`);
        return 3;
    }
    let r;
    try {
        r = await check(url);
    }
    catch (e) {
        err.write(`${e instanceof Error ? e.message : String(e)}\n`);
        return 3;
    }
    out.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${render(url, r)}\n`);
    return exitCodeOf(r);
}
const invokedDirectly = (() => {
    try {
        return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
    }
    catch {
        return false;
    }
})();
if (invokedDirectly || /[\\/](vet402|cli\.js)$/.test(process.argv[1] ?? "")) {
    main(process.argv.slice(2)).then((code) => process.exit(code));
}
