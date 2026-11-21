/** Solana recent blockhash validity (seconds) used when FAILED leaves a live authorization. */
export declare const SOLANA_LIVE_AUTH_SECONDS = 90;
export declare function hasLiveAuthorization(resource: string): boolean;
export declare function markPendingAuthorization(resource: string): void;
export declare function clearPendingAuthorization(resource: string): void;
export declare function rememberLiveAuthorization(resource: string, validBefore: number, nonce: string): void;
export declare function clearLiveAuthorization(resource: string): void;
