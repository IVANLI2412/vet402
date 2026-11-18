import { type ToolRunnableConfig } from "@langchain/core/tools";
import { z } from "zod";
import { type Vet402PayToolOptions } from "./pay-tool-core.js";
export declare function vet402PayTool(options: Vet402PayToolOptions): import("@langchain/core/tools").DynamicStructuredTool<z.ZodObject<{
    url: z.ZodString;
    method: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodString>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    url: string;
    body?: string | undefined;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
}, {
    url: string;
    body?: string | undefined;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
}>, {
    url: string;
    body?: string | undefined;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
}, {
    url: string;
    body?: string | undefined;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
}, string, unknown, "vet402_pay"> & {
    invoke(input: unknown, config?: ToolRunnableConfig): Promise<unknown>;
};
