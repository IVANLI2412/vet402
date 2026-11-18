import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { bindVet402PayTool, executeVet402Pay } from "./pay-tool-core.js";
const payParametersSchema = z.object({
    url: z.string().describe("HTTPS URL of the x402 seller to call"),
    method: z.string().optional().describe("HTTP method. Defaults to GET when omitted."),
    body: z.string().optional().describe("Request body as a string when the seller expects one."),
    headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Extra request headers. Authorization and payment headers are rejected."),
});
function refusalJson(reasonCodes) {
    return JSON.stringify({
        status: "refused",
        recommendation: null,
        reasonCodes,
        txHash: null,
        responseBody: null,
        responseBodyTruncated: false,
        guidance: "Payment was not made.",
        receipt: null,
    });
}
export function vet402PayTool(options) {
    const bound = bindVet402PayTool(options);
    const structured = tool(async (input) => {
        const result = await executeVet402Pay(input, bound);
        return JSON.stringify(result);
    }, {
        name: "vet402_pay",
        description: "Check an x402 seller with vet402, then pay only when the verdict is ALLOW. " +
            "Returns status, recommendation, reason codes, tx hash and the seller body.",
        schema: payParametersSchema,
    });
    const baseInvoke = structured.invoke.bind(structured);
    return Object.assign(structured, {
        async invoke(input, ...rest) {
            if (input === null || Array.isArray(input)) {
                return refusalJson(["tool_input_invalid"]);
            }
            if (typeof input !== "object" || input === null) {
                return refusalJson(["tool_input_invalid"]);
            }
            const record = input;
            if (typeof record.url !== "string") {
                return refusalJson(["tool_input_invalid_url"]);
            }
            return baseInvoke(input, rest[0]);
        },
    });
}
