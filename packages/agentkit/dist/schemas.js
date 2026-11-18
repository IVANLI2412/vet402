import { z } from "zod";
export const Vet402PayInputSchema = z.object({
    url: z.string().describe("HTTPS URL of the x402 seller to call"),
    method: z
        .string()
        .optional()
        .describe("HTTP method. Defaults to GET when omitted."),
    body: z
        .string()
        .optional()
        .describe("Request body as a string when the seller expects one."),
    headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Extra request headers. Authorization and payment headers are rejected."),
});
