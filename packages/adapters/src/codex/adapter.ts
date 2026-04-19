import type { AdapterRuntimePort } from "../runtime-port.js";
import { RuntimeBackedAdapter } from "../runtime-backed-adapter.js";
import type { AgentAdapterRuntimeConfig } from "../types.js";
import { CodexMapper } from "./mapper.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "./types.js";

export type CodexAdapterOptions = {
  id?: string;
  fallbackAgentId?: string;
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  runtimePort: AdapterRuntimePort<
    CodexRuntimeRequest,
    CodexRuntimeResponse,
    CodexRuntimeEvent
  >;
};

export class CodexAdapter extends RuntimeBackedAdapter<
  CodexRuntimeRequest,
  CodexRuntimeResponse,
  CodexRuntimeEvent
> {
  public constructor(options: CodexAdapterOptions) {
    super({
      id: options.id ?? "codex",
      kind: "codex",
      runtimePort: options.runtimePort,
      resolveConversationIdBySessionId: options.resolveConversationIdBySessionId,
      mapper: new CodexMapper({
        fallbackAgentId: options.fallbackAgentId ?? "codex"
      })
    });
  }

  public override async initialize(
    config: AgentAdapterRuntimeConfig = {}
  ): Promise<void> {
    await super.initialize({
      ...config,
      metadata: {
        ...(config.metadata ?? {}),
        adapterKind: "codex"
      }
    });
  }
}
