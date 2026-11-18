import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeVet402Pay } from "./pay-tool-core.js";
const payInputSchema = z.object({
    url: z.string().describe("HTTPS URL of the x402 seller to call"),
    method: z.string().optional().describe("HTTP method. Defaults to GET when omitted."),
    body: z.string().optional().describe("Request body as a string when the seller expects one."),
    headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Extra request headers. Authorization and payment headers are rejected."),
});
export function vet402PayTool(options) {
    return tool(async (input) => {
        const result = await executeVet402Pay(input, options);
        return JSON.stringify(result);
    }, {
        name: "vet402_pay",
        description: "Check an x402 seller with vet402, then pay only when the verdict is ALLOW. " +
            "Returns status, recommendation, reason codes, tx hash and the seller body.",
        schema: payInputSchema,
    });
}
