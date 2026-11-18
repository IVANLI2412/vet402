import "reflect-metadata";
import { z } from "zod";
import { ActionProvider } from "@coinbase/agentkit";
import { Network } from "@coinbase/agentkit";
import { Vet402PayInputSchema } from "./schemas.js";
import { type Vet402PayToolOptions } from "./pay-tool-core.js";
export type Vet402ActionProviderOptions = Vet402PayToolOptions;
export declare class Vet402ActionProvider extends ActionProvider {
    private readonly config;
    constructor(options: Vet402ActionProviderOptions);
    vet402Pay(args: z.infer<typeof Vet402PayInputSchema>): Promise<string>;
    supportsNetwork: (network: Network) => boolean;
}
export declare function vet402ActionProvider(options: Vet402ActionProviderOptions): Vet402ActionProvider;
