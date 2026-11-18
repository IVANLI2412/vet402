import { z } from "zod";
export declare const Vet402PayInputSchema: z.ZodObject<{
    url: z.ZodString;
    method: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodString>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    url: string;
    method?: string | undefined;
    body?: string | undefined;
    headers?: Record<string, string> | undefined;
}, {
    url: string;
    method?: string | undefined;
    body?: string | undefined;
    headers?: Record<string, string> | undefined;
}>;
