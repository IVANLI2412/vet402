# @vet402/agentkit

```bash
npm install @vet402/agentkit @vet402/sdk @coinbase/agentkit
```

```ts
import { vet402ActionProvider } from "@vet402/agentkit";
import { AgentKit } from "@coinbase/agentkit";

const provider = vet402ActionProvider({ account, maxUsd: 1, allowedHosts: ["seller.example"] });
const agentKit = await AgentKit.from({ actionProviders: [provider], walletProvider });
```

Register a Coinbase AgentKit action that calls `pay()` from `@vet402/sdk`.