import type { AdapterRuntimePort } from "../runtime-port.js";
import { RuntimeBackedAdapter } from "../runtime-backed-adapter.js";
import type { AgentAdapterRuntimeConfig } from "../types.js";
import { AcpMapper } from "./mapper.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeRequest,
  AcpRuntimeResponse
} from "./types.js";

export type AcpAdapterOptions = {
  id?: string;
  fallbackAgentId?: string;
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  runtimePort: AdapterRuntimePort<
    AcpRuntimeRequest,
    AcpRuntimeResponse,
    AcpRuntimeEvent
  >;
};

export class AcpAdapter extends RuntimeBackedAdapter<
  AcpRuntimeRequest,
  AcpRuntimeResponse,
  AcpRuntimeEvent
> {
  public constructor(options: AcpAdapterOptions) {
    super({
      id: options.id ?? "acp",
      kind: "acp",
      runtimePort: options.runtimePort,
      resolveConversationIdBySessionId: options.resolveConversationIdBySessionId,
      mapper: new AcpMapper({
        fallbackAgentId: options.fallbackAgentId ?? "acp"
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
        adapterKind: "acp"
      }
    });
  }
}
