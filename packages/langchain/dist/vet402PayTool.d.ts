import { z } from "zod";
import { type Vet402PayToolOptions } from "./pay-tool-core.js";
export declare function vet402PayTool(options: Vet402PayToolOptions): import("@langchain/core/tools").DynamicStructuredTool<z.ZodObject<{
    url: z.ZodString;
    method: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodString>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    url: string;
    headers?: Record<string, string> | undefined;
    method?: string | undefined;
    body?: string | undefined;
}, {
    url: string;
    headers?: Record<string, string> | undefined;
    method?: string | undefined;
    body?: string | undefined;
}>, {
    url: string;
    headers?: Record<string, string> | undefined;
    method?: string | undefined;
    body?: string | undefined;
}, {
    url: string;
    headers?: Record<string, string> | undefined;
    method?: string | undefined;
    body?: string | undefined;
}, string, unknown, "vet402_pay">;
