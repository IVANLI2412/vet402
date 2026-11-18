import { type Vet402PayToolOptions } from "./pay-tool-core.js";
export declare function vet402PayTool(options: Vet402PayToolOptions): ({
    deferLoading?: boolean;
    title?: string;
    providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
    metadata?: import("@ai-sdk/provider").JSONObject;
    inputSchema: import("ai").FlexibleSchema<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }>;
    contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
    needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
    onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputDelta?: ((options: {
        inputTextDelta: string;
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputAvailable?: ((options: {
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    toModelOutput?: ((options: {
        toolCallId: string;
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
        output: NoInfer<import("./pay-tool-core.js").Vet402PayToolResult>;
    }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
} & {
    outputSchema?: import("ai").FlexibleSchema<import("./pay-tool-core.js").Vet402PayToolResult> | undefined;
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
} & {
    description?: string | ((options: {
        context: NoInfer<import("@ai-sdk/provider-utils").Context>;
        experimental_sandbox?: import("ai").Experimental_SandboxSession;
    }) => string) | undefined;
    strict?: boolean;
    inputExamples?: {
        input: NoInfer<{
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        }>;
    }[] | undefined;
    id?: never;
    isProviderExecuted?: never;
    args?: never;
    supportsDeferredResults?: never;
} & {
    type?: undefined | "function";
} & {
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
}) | ({
    deferLoading?: boolean;
    title?: string;
    providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
    metadata?: import("@ai-sdk/provider").JSONObject;
    inputSchema: import("ai").FlexibleSchema<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }>;
    contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
    needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
    onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputDelta?: ((options: {
        inputTextDelta: string;
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputAvailable?: ((options: {
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    toModelOutput?: ((options: {
        toolCallId: string;
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
        output: NoInfer<import("./pay-tool-core.js").Vet402PayToolResult>;
    }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
} & {
    outputSchema?: import("ai").FlexibleSchema<import("./pay-tool-core.js").Vet402PayToolResult> | undefined;
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
} & {
    description?: string | ((options: {
        context: NoInfer<import("@ai-sdk/provider-utils").Context>;
        experimental_sandbox?: import("ai").Experimental_SandboxSession;
    }) => string) | undefined;
    strict?: boolean;
    inputExamples?: {
        input: NoInfer<{
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        }>;
    }[] | undefined;
    id?: never;
    isProviderExecuted?: never;
    args?: never;
    supportsDeferredResults?: never;
} & {
    type: "dynamic";
} & {
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
}) | ({
    deferLoading?: boolean;
    title?: string;
    providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
    metadata?: import("@ai-sdk/provider").JSONObject;
    inputSchema: import("ai").FlexibleSchema<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }>;
    contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
    needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
    onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputDelta?: ((options: {
        inputTextDelta: string;
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputAvailable?: ((options: {
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    toModelOutput?: ((options: {
        toolCallId: string;
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
        output: NoInfer<import("./pay-tool-core.js").Vet402PayToolResult>;
    }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
} & {
    outputSchema?: import("ai").FlexibleSchema<import("./pay-tool-core.js").Vet402PayToolResult> | undefined;
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
} & {
    type: "provider";
    id: `${string}.${string}`;
    args: Record<string, unknown>;
    description?: never;
    strict?: never;
    inputExamples?: never;
} & {
    isProviderExecuted: false;
    supportsDeferredResults?: never;
} & {
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
}) | ({
    deferLoading?: boolean;
    title?: string;
    providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
    metadata?: import("@ai-sdk/provider").JSONObject;
    inputSchema: import("ai").FlexibleSchema<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }>;
    contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
    needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
    onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputDelta?: ((options: {
        inputTextDelta: string;
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    onInputAvailable?: ((options: {
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
    } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
    toModelOutput?: ((options: {
        toolCallId: string;
        input: {
            url: string;
            headers?: Record<string, string> | undefined;
            method?: string | undefined;
            body?: string | undefined;
        };
        output: NoInfer<import("./pay-tool-core.js").Vet402PayToolResult>;
    }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
} & {
    outputSchema?: import("ai").FlexibleSchema<import("./pay-tool-core.js").Vet402PayToolResult> | undefined;
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
} & {
    type: "provider";
    id: `${string}.${string}`;
    args: Record<string, unknown>;
    description?: never;
    strict?: never;
    inputExamples?: never;
} & {
    isProviderExecuted: true;
    supportsDeferredResults?: boolean;
} & {
    execute: import("ai").ToolExecuteFunction<{
        url: string;
        headers?: Record<string, string> | undefined;
        method?: string | undefined;
        body?: string | undefined;
    }, import("./pay-tool-core.js").Vet402PayToolResult, NoInfer<import("@ai-sdk/provider-utils").Context>>;
});
