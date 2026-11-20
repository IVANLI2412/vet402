export declare function hasLiveAuthorization(resource: string): boolean;
export declare function rememberLiveAuthorization(resource: string, validBefore: number, nonce: string): void;
export declare function clearLiveAuthorization(resource: string): void;
