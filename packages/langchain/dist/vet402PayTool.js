import { ToolMessage } from "@langchain/core/messages";
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
const TOOL_NAME = "vet402_pay";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** LangChain agents call a tool with this envelope. The arguments are inside `args`. */
function toolCallOf(input) {
    if (!isRecord(input) || input.type !== "tool_call" || typeof input.id !== "string")
        return null;
    return { id: input.id, args: input.args };
}
function inputProblem(args) {
    if (!isRecord(args))
        return "tool_input_invalid";
    if (typeof args.url !== "string")
        return "tool_input_invalid_url";
    if (args.method !== undefined && typeof args.method !== "string")
        return "tool_input_invalid_method";
    if (args.body !== undefined && typeof args.body !== "string")
        return "tool_input_invalid_body";
    if (args.headers === undefined)
        return null;
    if (!isRecord(args.headers) || Object.values(args.headers).some((value) => typeof value !== "string")) {
        return "tool_input_invalid_headers";
    }
    return null;
}
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
        name: TOOL_NAME,
        description: "Check an x402 seller with vet402, then pay only when the verdict is ALLOW. " +
            "Returns status, recommendation, reason codes, tx hash and the seller body.",
        schema: payParametersSchema,
    });
    const baseInvoke = structured.invoke.bind(structured);
    return Object.assign(structured, {
        async invoke(input, config) {
            const call = toolCallOf(input);
            const problem = inputProblem(call ? call.args : input);
            if (problem === null)
                return baseInvoke(input, config);
            const content = refusalJson([problem]);
            return call ? new ToolMessage({ content, tool_call_id: call.id, name: TOOL_NAME }) : content;
        },
    });
}
