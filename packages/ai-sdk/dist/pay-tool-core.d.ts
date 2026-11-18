import { type PayOptions, type PayStatus, type PayerAccount } from "@vet402/sdk";
export declare const RESPONSE_BODY_CAP = 20000;
export type Vet402PayToolOptions = {
    account: PayerAccount;
    maxUsd?: number;
    allowWarn?: boolean;
    allowUnknown?: boolean;
    allowedHosts?: readonly string[];
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
};
export declare function executeVet402Pay(rawInput: Record<string, unknown>, options: Vet402PayToolOptions): Promise<Vet402PayToolResult>;
