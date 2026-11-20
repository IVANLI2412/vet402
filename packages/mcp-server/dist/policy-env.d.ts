import type { PayPolicy } from "@vet402/sdk";
export declare function resetSessionSpendForTests(): void;
export declare function sessionCapUsd(rawEnv: string | undefined): number;
export declare function policyFromEnv(env: NodeJS.ProcessEnv): PayPolicy;
/** Tool input may only tighten policy relative to env (never waive or lower floors). */
export declare function mergePolicyFromEnv(envPolicy: PayPolicy, tool?: PayPolicy): PayPolicy;
export declare function chargeSessionSpend(amountUsd: number, cap: number): boolean;
