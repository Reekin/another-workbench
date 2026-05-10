import type { JsonValue } from "./codex-app-server-generated/serde_json/JsonValue.js";

export type HostToolDefinition = {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

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

export type HostToolRegistration = HostToolDefinition & {
  isAvailable?: (context: HostToolAvailabilityContext) => boolean;
  handle: HostToolHandler;
};

const hostToolKey = (namespace: string | undefined, name: string): string =>
  `${namespace ?? ""}:${name}`;

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

  public listDefinitions(
    context?: HostToolAvailabilityContext
  ): HostToolDefinition[] {
    return [...this.toolsByKey.values()]
      .filter((tool) => !context || tool.isAvailable?.(context) !== false)
      .map(({ handle: _handle, isAvailable: _isAvailable, ...definition }) => ({
        ...definition
      }));
  }

  public isEmpty(): boolean {
    return this.toolsByKey.size === 0;
  }
}
