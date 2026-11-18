import { createHash } from "node:crypto";
import { pay, DEFAULT_MAX_PER_TX_USD, } from "@vet402/sdk";
export const RESPONSE_BODY_CAP = 20_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const TRUNC_SUFFIX = "...[truncated]";
const TRUNCATED_TEXT_MAX = RESPONSE_BODY_CAP - TRUNC_SUFFIX.length;
const RESPONSE_READ_BYTE_LIMIT = RESPONSE_BODY_CAP * 4 + 8_192;
const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "payment-signature", "x-payment"]);
const POLICY_INPUT_KEYS = ["account", "maxUsd", "allowWarn", "allowUnknown", "maxTotalUsd"];
const STATE = Symbol.for("@vet402/pay-tool-instance-state");
const USDC_UNITS = 1_000_000;
function createInstanceState() {
    return {
        paymentAttempts: { inProgress: new Set(), blocked: new Map() },
        committedUsd: 0,
        reservedUsd: 0,
        lock: Promise.resolve(),
    };
}
function assertAllowedHosts(allowedHosts) {
    if (allowedHosts === undefined)
        return;
    if (!Array.isArray(allowedHosts) || allowedHosts.some((entry) => typeof entry !== "string")) {
        throw new Error("vet402_pay_tool_allowedHosts_must_be_string_array");
    }
}
/** Attach per-instance counters and duplicate guards. Factories call this once per tool. */
export function bindVet402PayTool(options) {
    assertAllowedHosts(options.allowedHosts);
    const bound = { ...options };
    if (!bound[STATE])
        bound[STATE] = createInstanceState();
    return bound;
}
function instanceState(options) {
    const withState = options;
    return withState[STATE] ?? null;
}
function refuse(reason, recommendation = null, extra = {}) {
    return {
        status: "refused",
        recommendation,
        reasonCodes: [reason],
        txHash: null,
        responseBody: null,
        responseBodyTruncated: false,
        guidance: "Payment was not made.",
        receipt: null,
        ...extra,
    };
}
function truncateToCodePointBoundary(text, maxLen) {
    if ([...text].length <= maxLen)
        return text;
    const units = [...text];
    let end = maxLen;
    const code = units[end - 1]?.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdbff)
        end -= 1;
    return units.slice(0, end).join("");
}
async function readResponseBody(response) {
    if (!response?.body)
        return { text: null, truncated: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let decoded = "";
    let bytesRead = 0;
    let extra = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            bytesRead += value.byteLength;
            if (bytesRead > RESPONSE_READ_BYTE_LIMIT) {
                extra = true;
                const room = RESPONSE_READ_BYTE_LIMIT - (bytesRead - value.byteLength);
                if (room > 0)
                    decoded += decoder.decode(value.subarray(0, room), { stream: true });
                break;
            }
            decoded += decoder.decode(value, { stream: true });
        }
        decoded += decoder.decode();
    }
    catch {
        return { text: null, truncated: false };
    }
    finally {
        reader.cancel().catch(() => undefined);
    }
    const charCount = [...decoded].length;
    const truncated = extra || charCount > RESPONSE_BODY_CAP;
    if (!truncated)
        return { text: decoded, truncated: false };
    const text = `${truncateToCodePointBoundary(decoded, TRUNCATED_TEXT_MAX)}${TRUNC_SUFFIX}`;
    return { text, truncated: true };
}
function guidanceFor(status) {
    if (status === "paid")
        return "Payment completed.";
    if (status === "no_payment_required")
        return "The seller answered without requiring payment.";
    if (status === "failed") {
        return "Payment may have succeeded. Do not retry without checking chain state.";
    }
    return "Payment was not made.";
}
const UNRESERVED_SEGMENT = /%[0-9A-Fa-f]{2}/g;
function decodeUnnecessaryPathEncoding(pathname) {
    return pathname.replace(UNRESERVED_SEGMENT, (encoded) => {
        try {
            const decoded = decodeURIComponent(encoded);
            if (/^[A-Za-z0-9\-._~]+$/.test(decoded))
                return decoded;
        }
        catch {
            /* keep percent-encoded */
        }
        return encoded;
    });
}
function normalizedHostPort(parsed) {
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port && parsed.port !== "443" ? `:${parsed.port}` : "";
    return `${host}${port}`;
}
/** Normalized URL for pay() and in-flight deduplication keys. */
function normalizedPaymentUrl(parsed) {
    const hostPort = normalizedHostPort(parsed);
    const path = decodeUnnecessaryPathEncoding(parsed.pathname);
    const query = parsed.search === "?" || parsed.search === "" ? "" : parsed.search;
    return `https://${hostPort}${path}${query}`;
}
/** Origin plus pathname only; used after `failed` to block respellings. */
function failedPaymentPathKey(parsed) {
    const hostPort = normalizedHostPort(parsed);
    const path = decodeUnnecessaryPathEncoding(parsed.pathname);
    return `https://${hostPort}${path}`;
}
function bodySha256(body) {
    return createHash("sha256").update(body ?? "", "utf8").digest("hex");
}
function paymentAttemptKey(parsed, method, body) {
    return `${method}\0${normalizedPaymentUrl(parsed)}\0${bodySha256(body)}`;
}
function receiptSummary(receipt) {
    if (!receipt)
        return null;
    const nonce = receipt.retry.authorization?.nonce ?? receipt.retry.svm?.memo ?? null;
    return {
        nonce,
        payTo: receipt.payTo,
        amount: receipt.amount,
        network: receipt.network,
    };
}
function amountUsdFromReceipt(receipt) {
    if (!receipt?.amount || !/^[1-9][0-9]*$/.test(receipt.amount))
        return null;
    return Number(receipt.amount) / USDC_UNITS;
}
function parseAllowedHost(entry) {
    const lower = entry.trim().toLowerCase();
    const lastColon = lower.lastIndexOf(":");
    if (lastColon > 0 && lastColon === lower.indexOf(":")) {
        const host = lower.slice(0, lastColon);
        const port = Number(lower.slice(lastColon + 1));
        if (Number.isInteger(port) && port > 0 && port <= 65_535)
            return { host, port };
    }
    return { host: lower, port: 443 };
}
function urlPort(parsed) {
    if (parsed.port) {
        const port = Number(parsed.port);
        if (Number.isInteger(port) && port > 0)
            return port;
    }
    return 443;
}
function hostIsAllowed(parsed, allowedHosts) {
    const hostname = parsed.hostname.toLowerCase();
    const port = urlPort(parsed);
    return allowedHosts.some((entry) => {
        const rule = parseAllowedHost(entry);
        return rule.host === hostname && rule.port === port;
    });
}
function isPlainHeaderRecord(headers) {
    if (typeof headers !== "object" || headers === null || Array.isArray(headers))
        return false;
    if (headers instanceof Headers || headers instanceof Map || headers instanceof URLSearchParams)
        return false;
    if (typeof headers[Symbol.iterator] === "function")
        return false;
    const proto = Object.getPrototypeOf(headers);
    return proto === Object.prototype || proto === null;
}
function withTimeoutFetch(base, timeoutMs) {
    return async (input, init = {}) => {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        let merged = timeoutSignal;
        if (init.signal !== undefined && init.signal !== null) {
            merged =
                typeof AbortSignal.any === "function"
                    ? AbortSignal.any([init.signal, timeoutSignal])
                    : timeoutSignal;
        }
        const call = base(input, { ...init, signal: merged });
        const onTimeout = new Promise((_, reject) => {
            if (timeoutSignal.aborted) {
                reject(Object.assign(new Error("fetch_timeout"), { cause: timeoutSignal.reason }));
                return;
            }
            timeoutSignal.addEventListener("abort", () => {
                reject(Object.assign(new Error("fetch_timeout"), { cause: timeoutSignal.reason }));
            }, { once: true });
        });
        try {
            return await Promise.race([call, onTimeout]);
        }
        catch (err) {
            if (err instanceof Error && err.message === "fetch_timeout")
                throw err;
            if (timeoutSignal.aborted) {
                throw Object.assign(new Error("fetch_timeout"), { cause: err });
            }
            throw err;
        }
    };
}
async function withInstanceLock(state, fn) {
    const prev = state.lock;
    let release;
    state.lock = new Promise((resolve) => {
        release = resolve;
    });
    await prev;
    try {
        return await fn();
    }
    finally {
        release();
    }
}
function beginPaymentAttempt(state, attemptKey, failedPathKey) {
    const ledger = state.paymentAttempts;
    const priorFailed = ledger.blocked.get(failedPathKey);
    if (priorFailed)
        return priorFailed;
    if (ledger.inProgress.has(attemptKey))
        return "in_progress";
    ledger.inProgress.add(attemptKey);
    return null;
}
function clearInProgressAttempt(state, key) {
    state.paymentAttempts.inProgress.delete(key);
}
function finalizePaymentAttempt(state, attemptKey, failedPathKey, status, summary) {
    const ledger = state.paymentAttempts;
    ledger.inProgress.delete(attemptKey);
    if (status === "failed" && summary) {
        ledger.blocked.set(failedPathKey, summary);
    }
}
function duplicateInProgress() {
    return {
        status: "refused",
        recommendation: null,
        reasonCodes: ["duplicate_payment_in_progress"],
        txHash: null,
        responseBody: null,
        responseBodyTruncated: false,
        guidance: "Payment was not made.",
        receipt: null,
    };
}
function duplicateBlocked(summary) {
    return {
        status: "refused",
        recommendation: null,
        reasonCodes: ["duplicate_payment_blocked"],
        txHash: null,
        responseBody: null,
        responseBodyTruncated: false,
        guidance: "Do not retry this payment.",
        receipt: summary ?? null,
    };
}
function scrubValue(text, secrets) {
    if (text === null || secrets.length === 0)
        return text;
    let out = text;
    for (const secret of secrets) {
        if (secret.length > 0)
            out = out.split(secret).join("[redacted]");
    }
    return out;
}
function scrubToolResult(result, secrets, responseBody) {
    const receipt = result.receipt
        ? {
            nonce: scrubValue(result.receipt.nonce, secrets),
            payTo: scrubValue(result.receipt.payTo, secrets),
            amount: scrubValue(result.receipt.amount, secrets),
            network: scrubValue(result.receipt.network, secrets),
        }
        : result.receipt;
    return {
        status: result.status,
        recommendation: scrubValue(result.recommendation, secrets),
        reasonCodes: result.reasonCodes.map((code) => scrubValue(code, secrets) ?? ""),
        txHash: scrubValue(result.txHash, secrets),
        responseBody,
        responseBodyTruncated: result.responseBodyTruncated,
        guidance: scrubValue(result.guidance, secrets) ?? result.guidance,
        receipt,
    };
}
export async function executeVet402Pay(rawInput, options) {
    const state = instanceState(options);
    if (!state)
        return refuse("tool_not_bound");
    if (options.allowedHosts === undefined) {
        return refuse("allowed_hosts_required");
    }
    for (const key of POLICY_INPUT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(rawInput, key) && rawInput[key] !== undefined) {
            return refuse("tool_input_policy_field");
        }
    }
    const url = rawInput.url;
    if (typeof url !== "string" || url.length === 0) {
        return refuse("tool_input_invalid_url");
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return refuse("tool_input_invalid_url");
    }
    if (parsed.protocol !== "https:") {
        return refuse("tool_input_invalid_url");
    }
    if (options.allowedHosts.length === 0 || !hostIsAllowed(parsed, options.allowedHosts)) {
        return refuse("host_not_allowed");
    }
    const method = rawInput.method === undefined
        ? "GET"
        : typeof rawInput.method === "string"
            ? rawInput.method.toUpperCase()
            : null;
    if (method === null)
        return refuse("tool_input_invalid_method");
    const headers = rawInput.headers;
    if (headers !== undefined) {
        if (!isPlainHeaderRecord(headers)) {
            return refuse("tool_input_invalid_headers");
        }
        for (const name of Object.keys(headers)) {
            if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
                return refuse("forbidden_header");
            }
            if (typeof headers[name] !== "string") {
                return refuse("tool_input_invalid_headers");
            }
        }
    }
    const bodyString = rawInput.body !== undefined ? (typeof rawInput.body === "string" ? rawInput.body : null) : undefined;
    if (bodyString === null)
        return refuse("tool_input_invalid_body");
    const init = { method };
    if (bodyString !== undefined)
        init.body = bodyString;
    if (headers) {
        init.headers = headers;
    }
    const sellerUrl = normalizedPaymentUrl(parsed);
    const attemptKey = paymentAttemptKey(parsed, method, bodyString);
    const failedPathKey = failedPaymentPathKey(parsed);
    const attemptGate = beginPaymentAttempt(state, attemptKey, failedPathKey);
    if (attemptGate !== null) {
        if (attemptGate === "in_progress")
            return duplicateInProgress();
        return duplicateBlocked(attemptGate);
    }
    const perTxUsd = options.maxUsd ?? DEFAULT_MAX_PER_TX_USD;
    const totalCap = options.maxTotalUsd ?? perTxUsd * 10;
    const reserved = await withInstanceLock(state, async () => {
        const remaining = totalCap - state.committedUsd - state.reservedUsd;
        if (remaining < perTxUsd)
            return false;
        state.reservedUsd += perTxUsd;
        return true;
    });
    if (!reserved) {
        clearInProgressAttempt(state, attemptKey);
        return refuse("max_total_usd_exceeded");
    }
    const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const baseFetch = options.fetch ?? globalThis.fetch;
    const innerTimed = withTimeoutFetch(baseFetch, timeoutMs);
    const paymentHeaderSecrets = [];
    let sellerTimedOut = false;
    const timedFetch = async (input, init) => {
        const hdrs = new Headers(init?.headers);
        for (const name of ["payment-signature", "x-payment"]) {
            const value = hdrs.get(name);
            if (value)
                paymentHeaderSecrets.push(value);
        }
        try {
            return await innerTimed(input, init);
        }
        catch (err) {
            if (err instanceof Error && err.message === "fetch_timeout")
                sellerTimedOut = true;
            throw err;
        }
    };
    try {
        const result = await pay(sellerUrl, init, {
            account: options.account,
            maxUsd: options.maxUsd,
            allowWarn: options.allowWarn,
            allowUnknown: options.allowUnknown,
            apiKey: options.apiKey,
            apiUrl: options.apiUrl,
            fetch: timedFetch,
            network: options.network,
            decisionStore: options.decisionStore,
        });
        if (sellerTimedOut &&
            result.status === "refused" &&
            result.reasonCodes.length > 0 &&
            result.reasonCodes[0] === "seller_unreachable") {
            await withInstanceLock(state, async () => {
                state.reservedUsd -= perTxUsd;
            });
            clearInProgressAttempt(state, attemptKey);
            return refuse("fetch_timeout");
        }
        const summary = receiptSummary(result.receipt);
        const signedSpend = result.signed && (result.status === "paid" || result.status === "failed");
        const spentUsd = signedSpend ? (amountUsdFromReceipt(result.receipt) ?? perTxUsd) : 0;
        await withInstanceLock(state, async () => {
            state.reservedUsd -= perTxUsd;
            if (signedSpend)
                state.committedUsd += spentUsd;
        });
        finalizePaymentAttempt(state, attemptKey, failedPathKey, result.status, summary);
        const body = await readResponseBody(result.response);
        const redactedBody = scrubValue(body.text, paymentHeaderSecrets);
        const raw = {
            status: result.status,
            recommendation: result.recommendation,
            reasonCodes: result.reasonCodes,
            txHash: result.txHash,
            responseBody: redactedBody,
            responseBodyTruncated: body.truncated,
            guidance: guidanceFor(result.status),
            receipt: summary,
        };
        return scrubToolResult(raw, paymentHeaderSecrets, redactedBody);
    }
    catch (err) {
        await withInstanceLock(state, async () => {
            state.reservedUsd -= perTxUsd;
        });
        clearInProgressAttempt(state, attemptKey);
        const message = err instanceof Error ? err.message : "tool_execution_error";
        if (message === "fetch_timeout")
            return refuse("fetch_timeout");
        if (message.startsWith("invalid_"))
            return refuse("tool_execution_error");
        return refuse("tool_execution_error");
    }
}
