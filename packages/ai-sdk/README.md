# @vet402/ai-sdk

Expose vet402-checked x402 payments as a Vercel AI SDK tool.

```ts
import { vet402PayTool } from "@vet402/ai-sdk";
import { generateText } from "ai";

const payTool = vet402PayTool({ account, maxUsd: 1 });
```