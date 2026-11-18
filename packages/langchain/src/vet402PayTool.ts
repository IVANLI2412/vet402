import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { bindVet402PayTool, executeVet402Pay, type Vet402PayToolOptions } from "./pay-tool-core.js";

const payInputSchema = z.record(z.unknown());

export function vet402PayTool(options: Vet402PayToolOptions) {
  const bound = bindVet402PayTool(options);
  return tool(
    async (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
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