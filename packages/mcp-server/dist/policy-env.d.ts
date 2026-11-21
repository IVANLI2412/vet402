import type { PayPolicy } from "@vet402/sdk";
export declare function resetSessionSpendForTests(): void;
export declare function sessionCapUsd(rawEnv: string | undefined): number;
export declare function policyFromEnv(env: NodeJS.ProcessEnv): PayPolicy;
/** Tool input may only tighten policy relative to env (never waive or lower floors). */
export declare function mergePolicyFromEnv(envPolicy: PayPolicy, tool?: PayPolicy): PayPolicy;
/** @deprecated Use tryReserveSessionSpend — kept for tests that import chargeSessionSpend directly. */
export declare function sessionWouldExceed(amountUsd: number, cap: number): boolean;
/** Reserve spend before an awaited payment; release with {@link releaseSessionSpend} if nothing was signed. */
export declare function tryReserveSessionSpend(amountUsd: number, cap: number): boolean;
export declare function releaseSessionSpend(amountUsd: number): void;
export declare function sessionSpentTotal(): number;
export declare function chargeSessionSpend(amountUsd: number, cap: number): boolean;
