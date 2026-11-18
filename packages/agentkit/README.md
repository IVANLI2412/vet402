# @vet402/agentkit

```bash
npm install @vet402/agentkit @vet402/sdk @coinbase/agentkit
```

```ts
import { vet402ActionProvider } from "@vet402/agentkit";

const provider = vet402ActionProvider({ account, allowedHosts: ["seller.example"] });
```

Register a Coinbase AgentKit action that calls `pay()` from `@vet402/sdk`.