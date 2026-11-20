/** Pure keccak256 (Ethereum padding). No viem / no ENS modules — safe for pay-or-refuse static graph (T30). */
/** keccak256 (Ethereum's, i.e. pre-FIPS padding 0x01). */
export declare function keccak256Bytes(data: Uint8Array): Uint8Array;
