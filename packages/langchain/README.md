# @vet402/langchain

Expose vet402-checked x402 payments as a LangChain tool.

```ts
import { vet402PayTool } from "@vet402/langchain";

const payTool = vet402PayTool({ account, allowedHosts: ["seller.example"] });
```