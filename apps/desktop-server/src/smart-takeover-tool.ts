import type {
  HostToolInvocation,
  HostToolInputSchemaResolver,
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
  presetIdDescription?: string | (() => string | Promise<string>);
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

const defaultPresetIdDescription =
  "Preset prompt name from ~/.another-workbench/takeover. Required when action is start or omitted to start takeover; not needed for help or stop.";

const createSmartTakeoverInputSchema = (presetIdDescription: string) => ({
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["help", "start", "stop"],
      description:
        "Use help for detailed usage, start to enable takeover, stop to disable takeover for this session."
    },
    presetId: {
      type: "string",
      description: presetIdDescription
    },
    helpTopic: {
      type: "string",
      enum: ["overview", "presets", "loop", "result"],
      description:
        "Optional help section when action is help."
    },
    context: {
      type: "string",
      description:
        "Task requirement context for the takeover agent. Provide the stable requirement materials the reviewer needs to understand what you were assigned to deliver and what counts as acceptable: task goal, project paths, source-of-truth files/data, durable constraints, scope boundaries, acceptance points, and requirement/design documents or checklists that apply across the task. This is not a prompt telling the reviewer how to work. Do not include review procedure instructions, step-by-step verification commands, progress logs, latest status, or checkpoint/phase-specific details that cannot remain useful from start to finish. Do not call SmartTakeover again just to update context after an incomplete verdict; continue from the feedback while keeping the original task context."
    }
  },
  additionalProperties: false
});

const createSmartTakeoverInputSchemaResolver = (
  options: SmartTakeoverToolOptions
): HostToolInputSchemaResolver => async () => {
  const description =
    typeof options.presetIdDescription === "function"
      ? await options.presetIdDescription()
      : options.presetIdDescription;
  return createSmartTakeoverInputSchema(
    description ?? defaultPresetIdDescription
  );
};

export const createSmartTakeoverHostTool = (
  options: SmartTakeoverToolOptions = {}
): HostToolRegistration => ({
  namespace: smartTakeoverToolNamespace,
  name: smartTakeoverToolName,
  description:
    "Let another agent act as the user to supervise this session. Call this at the beginning of a complex task or long-running task. The context should provide stable task requirements and acceptance context needed to judge the work; it is not a prompt telling the reviewer how to work or a progress log.",
  inputSchema: createSmartTakeoverInputSchemaResolver(options),
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
          "complete accepts the current state and ends takeover; incomplete sends feedback as the user's next reply."
      },
      response: {
        type: "string",
        description:
          "The complete user-facing response to send back to the agent."
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
