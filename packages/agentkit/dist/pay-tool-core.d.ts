import { type PayOptions, type PayStatus, type PayerAccount } from "@vet402/sdk";
export declare const RESPONSE_BODY_CAP = 20000;
export declare const DEFAULT_FETCH_TIMEOUT_MS = 30000;
export type Vet402PayReceiptSummary = {
    nonce: string | null;
    payTo: string | null;
    amount: string | null;
    network: string | null;
};
export type Vet402PayToolOptions = {
    account: PayerAccount;
    maxUsd?: number;
    /** Signed-payment total cap for this tool instance. Default is 10× {@link maxUsd}. */
    maxTotalUsd?: number;
    allowWarn?: boolean;
    allowUnknown?: boolean;
    allowedHosts: readonly string[];
    fetchTimeoutMs?: number;
    apiKey?: string;
    apiUrl?: string;
    fetch?: typeof fetch;
    network?: PayOptions["network"];
    decisionStore?: string;
};
export type Vet402PayToolResult = {
    status: PayStatus;
    recommendation: string | null;
    reasonCodes: string[];
    txHash: string | null;
    responseBody: string | null;
    responseBodyTruncated: boolean;
    guidance: string;
    receipt?: Vet402PayReceiptSummary | null;
};
/** Attach per-instance counters and duplicate guards. Factories call this once per tool. */
export declare function bindVet402PayTool(options: Vet402PayToolOptions): Vet402PayToolOptions;
export declare function executeVet402Pay(rawInput: Record<string, unknown>, options: Vet402PayToolOptions): Promise<Vet402PayToolResult>;
