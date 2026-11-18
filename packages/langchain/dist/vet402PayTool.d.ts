import { z } from "zod";
import { type Vet402PayToolOptions } from "./pay-tool-core.js";
export declare function vet402PayTool(options: Vet402PayToolOptions): import("@langchain/core/tools").DynamicStructuredTool<z.ZodEffects<z.ZodUnion<[z.ZodObject<{
    url: z.ZodUnknown;
    method: z.ZodOptional<z.ZodUnknown>;
    body: z.ZodOptional<z.ZodUnknown>;
    headers: z.ZodOptional<z.ZodUnknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    url: z.ZodUnknown;
    method: z.ZodOptional<z.ZodUnknown>;
    body: z.ZodOptional<z.ZodUnknown>;
    headers: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    url: z.ZodUnknown;
    method: z.ZodOptional<z.ZodUnknown>;
    body: z.ZodOptional<z.ZodUnknown>;
    headers: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">>, z.ZodNull, z.ZodArray<z.ZodUnknown, "many">]>, unknown[] | z.objectOutputType<{
    url: z.ZodUnknown;
    method: z.ZodOptional<z.ZodUnknown>;
    body: z.ZodOptional<z.ZodUnknown>;
    headers: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough"> | null, unknown>, unknown[] | z.objectOutputType<{
    url: z.ZodUnknown;
    method: z.ZodOptional<z.ZodUnknown>;
    body: z.ZodOptional<z.ZodUnknown>;
    headers: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough"> | null, unknown, string, unknown, "vet402_pay">;
