import type {
  HostToolInvocation,
  HostToolRegistration,
  HostToolResult
} from "./host-tools.js";

export const smartTakeoverToolNamespace = "another_workbench";
export const smartTakeoverToolName = "SmartTakeover";
export const takeoverVerdictToolName = "SubmitTakeoverVerdict";

export type SmartTakeoverRequest = {
  parentSessionId: string;
  sourceTurnId?: string;
  sourceToolCallId?: string;
  requestedBy: {
    engineId: string;
    providerSessionId: string;
    providerTurnId?: string;
  };
  arguments: HostToolInvocation["arguments"];
};

export type SmartTakeoverToolOptions = {
  onRequest?: (
    request: SmartTakeoverRequest
  ) => void | HostToolResult | Promise<void | HostToolResult>;
  isAvailable?: HostToolRegistration["isAvailable"];
};

export type TakeoverVerdictRequest = {
  takeoverSessionId: string;
  sourceTurnId?: string;
  sourceToolCallId?: string;
  requestedBy: {
    engineId: string;
    providerSessionId: string;
    providerTurnId?: string;
  };
  arguments: HostToolInvocation["arguments"];
};

export type SubmitTakeoverVerdictToolOptions = {
  onSubmit?: (
    request: TakeoverVerdictRequest
  ) => HostToolResult | Promise<HostToolResult>;
  isAvailable?: HostToolRegistration["isAvailable"];
};

export const createSmartTakeoverHostTool = (
  options: SmartTakeoverToolOptions = {}
): HostToolRegistration => ({
  namespace: smartTakeoverToolNamespace,
  name: smartTakeoverToolName,
  description:
    "Let another agent act as the user to supervise this session. It will automatically check your work after you finish responding and give feedback. Use near completion of complex feature work or long-running tasks with many work items that need repeated review and iteration.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["help", "start"],
        description: "Use help for detailed usage, start to enable takeover."
      },
      helpTopic: {
        type: "string",
        enum: ["overview", "presets", "brief", "loop", "result"],
        description: "Optional help section when action is help."
      },
      presetId: {
        type: "string",
        description: "Preset prompt name from ~/.another-workbench/takeover."
      },
      brief: {
        type: "string",
        description: "Situation-specific handoff notes for the takeover agent."
      },
      customPrompt: {
        type: "string",
        description: "Optional prompt text appended after the selected preset."
      },
      successCriteria: {
        type: "array",
        items: { type: "string" },
        description: "Concrete acceptance criteria for approval."
      },
      focusFiles: {
        type: "array",
        items: { type: "string" },
        description: "Relevant workspace paths the takeover agent should inspect."
      }
    },
    additionalProperties: false
  },
  deferLoading: false,
  isAvailable: options.isAvailable,
  handle: async (invocation): Promise<HostToolResult> => {
    const result = await options.onRequest?.({
      parentSessionId: invocation.context.sessionId,
      sourceTurnId: invocation.context.providerTurnId,
      sourceToolCallId: invocation.context.providerToolCallId,
      requestedBy: {
        engineId: invocation.context.engineId,
        providerSessionId: invocation.context.providerSessionId,
        providerTurnId: invocation.context.providerTurnId
      },
      arguments: invocation.arguments
    });
    if (result) {
      return result;
    }

    return {
      contentItems: [
        {
          type: "inputText",
          text: `SmartTakeover request recorded for session ${invocation.context.sessionId}.`
        }
      ],
      success: true
    };
  }
});

export const createSubmitTakeoverVerdictHostTool = (
  options: SubmitTakeoverVerdictToolOptions = {}
): HostToolRegistration => ({
  namespace: smartTakeoverToolNamespace,
  name: takeoverVerdictToolName,
  description:
    "Submit the final takeover verdict to Another Workbench and end this takeover check.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["complete", "incomplete"],
        description:
          "complete passes the takeover check; incomplete returns work to the parent agent."
      },
      response: {
        type: "string",
        description:
          "The complete virtual-user response to return to the parent agent."
      }
    },
    required: ["verdict", "response"],
    additionalProperties: false
  },
  deferLoading: false,
  isAvailable: options.isAvailable,
  handle: async (invocation): Promise<HostToolResult> => {
    return (
      (await options.onSubmit?.({
        takeoverSessionId: invocation.context.sessionId,
        sourceTurnId: invocation.context.providerTurnId,
        sourceToolCallId: invocation.context.providerToolCallId,
        requestedBy: {
          engineId: invocation.context.engineId,
          providerSessionId: invocation.context.providerSessionId,
          providerTurnId: invocation.context.providerTurnId
        },
        arguments: invocation.arguments
      })) ?? {
        contentItems: [
          {
            type: "inputText",
            text: "Takeover verdict submitted."
          }
        ],
        success: true
      }
    );
  }
});
