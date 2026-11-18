# @vet402/agentkit

Register a Coinbase AgentKit action that calls `pay()` from `@vet402/sdk`.

```ts
import { vet402ActionProvider } from "@vet402/agentkit";
import { AgentKit } from "@coinbase/agentkit";

const provider = vet402ActionProvider({ account, maxUsd: 1 });
const agentKit = await AgentKit.from({ actionProviders: [provider], walletProvider });
```