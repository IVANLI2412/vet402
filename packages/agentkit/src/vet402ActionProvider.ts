import "reflect-metadata";
import { z } from "zod";
import { ActionProvider } from "@coinbase/agentkit";
import { CreateAction } from "@coinbase/agentkit";
import { Network } from "@coinbase/agentkit";
import { Vet402PayInputSchema } from "./schemas.js";
import { bindVet402PayTool, executeVet402Pay, type Vet402PayToolOptions } from "./pay-tool-core.js";

export type Vet402ActionProviderOptions = Vet402PayToolOptions;

export class Vet402ActionProvider extends ActionProvider {
  private readonly config: Vet402PayToolOptions;

  constructor(options: Vet402ActionProviderOptions) {
    super("vet402", []);
    this.supportsNetwork = () => true;
    this.config = bindVet402PayTool(options);
  }

  @CreateAction({
    name: "vet402_pay",
    description:
      "Check an x402 seller with vet402, then pay only when the verdict is ALLOW. " +
      "Returns status, recommendation, reason codes, tx hash and the seller body. " +
      "Never pass account, maxUsd, allowWarn or allowUnknown in the arguments.",
    schema: Vet402PayInputSchema,
  })
  async vet402Pay(args: z.infer<typeof Vet402PayInputSchema>): Promise<string> {
    const result = await executeVet402Pay(args, this.config);
    return JSON.stringify(result);
  }

  supportsNetwork: (network: Network) => boolean;
}

export function vet402ActionProvider(options: Vet402ActionProviderOptions): Vet402ActionProvider {
  return new Vet402ActionProvider(options);
}