import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { bindVet402PayTool, executeVet402Pay, type Vet402PayToolOptions } from "./pay-tool-core.js";

const payInputFields = z.object({
  url: z.unknown().describe("HTTPS URL of the x402 seller to call"),
  method: z.unknown().optional().describe("HTTP method. Defaults to GET when omitted."),
  body: z.unknown().optional().describe("Request body as a string when the seller expects one."),
  headers: z
    .unknown()
    .optional()
    .describe("Extra request headers. Authorization and payment headers are rejected."),
});

const payInputSchema = z.preprocess(
  (value) => value,
  z.union([payInputFields.passthrough(), z.null(), z.array(z.unknown())]),
);

export function vet402PayTool(options: Vet402PayToolOptions) {
  const bound = bindVet402PayTool(options);
  return tool(
    async (input) => {
      if (input === null || Array.isArray(input)) {
        return JSON.stringify({
          status: "refused",
          recommendation: null,
          reasonCodes: ["tool_input_invalid"],
          txHash: null,
          responseBody: null,
          responseBodyTruncated: false,
          guidance: "Payment was not made.",
          receipt: null,
        });
      }
      if (typeof input !== "object") {
        return JSON.stringify({
          status: "refused",
          recommendation: null,
          reasonCodes: ["tool_input_invalid"],
          txHash: null,
          responseBody: null,
          responseBodyTruncated: false,
          guidance: "Payment was not made.",
          receipt: null,
        });
      }
      const result = await executeVet402Pay(input as Record<string, unknown>, bound);
      return JSON.stringify(result);
    },
    {
      name: "vet402_pay",
      description:
        "Check an x402 seller with vet402, then pay only when the verdict is ALLOW. " +
        "Returns status, recommendation, reason codes, tx hash and the seller body.",
      schema: payInputSchema,
    },
  );
}