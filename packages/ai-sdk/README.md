# @vet402/ai-sdk

```bash
npm install @vet402/ai-sdk @vet402/sdk ai
```

```ts
import { vet402PayTool } from "@vet402/ai-sdk";
import { generateText } from "ai";

const payTool = vet402PayTool({ account, maxUsd: 1, allowedHosts: ["seller.example"] });
```

Expose vet402-checked x402 payments as a Vercel AI SDK tool.