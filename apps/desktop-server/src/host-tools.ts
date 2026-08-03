import type { JsonValue } from "./codex-app-server-generated/serde_json/JsonValue.js";

export type HostToolDefinition = {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

export type HostToolInputSchemaResolver = (
  context?: HostToolAvailabilityContext
) => JsonValue | Promise<JsonValue>;

export type HostToolDescriptionResolver = (
  context?: HostToolAvailabilityContext
) => string | Promise<string>;

export type HostToolInvocationContext = {
  engineId: string;
  sessionId: string;
  providerSessionId: string;
  providerTurnId?: string;
  providerToolCallId?: string;
};

export type HostToolAvailabilityContext = {
  engineId: string;
  sessionId: string;
};

export type HostToolInvocation = {
  definition: HostToolDefinition;
  arguments: JsonValue;
  context: HostToolInvocationContext;
};

export type HostToolContentItem =
  | {
      type: "inputText";
      text: string;
    }
  | {
      type: "inputImage";
      imageUrl: string;
    };

export type HostToolResult = {
  contentItems: HostToolContentItem[];
  success: boolean;
};

export type HostToolHandler = (
  invocation: HostToolInvocation
) => HostToolResult | Promise<HostToolResult>;

export type HostToolRegistration = Omit<
  HostToolDefinition,
  "description" | "inputSchema"
> & {
  description: string | HostToolDescriptionResolver;
  inputSchema: JsonValue | HostToolInputSchemaResolver;
  isAvailable?: (context: HostToolAvailabilityContext) => boolean;
  handle: HostToolHandler;
};

const hostToolKey = (namespace: string | undefined, name: string): string =>
  `${namespace ?? ""}:${name}`;

export const resolveHostToolDefinition = async (
  tool: HostToolRegistration,
  context?: HostToolAvailabilityContext
): Promise<HostToolDefinition> => {
  const {
    handle: _handle,
    isAvailable: _isAvailable,
    description,
    inputSchema,
    ...definition
  } = tool;
  return {
    ...definition,
    description:
      typeof description === "function"
        ? await description(context)
        : description,
    inputSchema:
      typeof inputSchema === "function"
        ? await inputSchema(context)
        : inputSchema
  };
};

export class HostToolRegistry {
  private readonly toolsByKey = new Map<string, HostToolRegistration>();

  public constructor(registrations: HostToolRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  public register(registration: HostToolRegistration): void {
    this.toolsByKey.set(hostToolKey(registration.namespace, registration.name), {
      ...registration
    });
  }

  public resolve(input: {
    namespace?: string;
    name: string;
    context?: HostToolAvailabilityContext;
  }): HostToolRegistration | undefined {
    const tool = this.toolsByKey.get(hostToolKey(input.namespace, input.name));
    if (!tool) {
      return undefined;
    }
    if (input.context && tool.isAvailable?.(input.context) === false) {
      return undefined;
    }
    return tool;
  }

  public async listDefinitions(
    context?: HostToolAvailabilityContext
  ): Promise<HostToolDefinition[]> {
    const definitions: HostToolDefinition[] = [];
    for (const tool of this.toolsByKey.values()) {
      if (context && tool.isAvailable?.(context) === false) {
        continue;
      }
      definitions.push(await resolveHostToolDefinition(tool, context));
    }
    return definitions;
  }

  public isEmpty(): boolean {
    return this.toolsByKey.size === 0;
  }
}
