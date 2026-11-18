# @vet402/langchain

```bash
npm install @vet402/langchain @vet402/sdk @langchain/core
```

```ts
import { vet402PayTool } from "@vet402/langchain";

const payTool = vet402PayTool({ account, allowedHosts: ["seller.example"] });
```

Expose vet402-checked x402 payments as a LangChain tool.