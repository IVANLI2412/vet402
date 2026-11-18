import { z } from "zod";
import { type Vet402PayToolOptions } from "./pay-tool-core.js";
export declare function vet402PayTool(options: Vet402PayToolOptions): import("@langchain/core/tools").DynamicStructuredTool<z.ZodRecord<z.ZodString, z.ZodUnknown>, Record<string, unknown>, Record<string, unknown>, string, unknown, "vet402_pay">;
