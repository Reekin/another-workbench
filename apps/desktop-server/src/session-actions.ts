import {
  CapabilityRegistry,
  type SessionActionDescriptor,
  type SessionActionKind,
  type SessionActionResult,
  type AgentWorkbenchCapabilities,
  type SessionActionsCapability,
  type SessionCapabilityContext as SessionActionProviderContext
} from "./capability-registry.js";
import type { SessionIndexStore } from "./session-index.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";

type SessionActionsProviderOptions =
  | {
      capabilities: CapabilityRegistry;
    }
  | {
      runtimeService: WorkbenchRuntimeService;
      sessionIndexStore: SessionIndexStore;
      providers?: SessionAgentActionsProvider[];
    };

export type SessionAgentActionsProvider = SessionActionsCapability & {
  readonly agentId: string;
};

export type {
  SessionActionDescriptor,
  SessionActionKind,
  SessionActionResult,
  SessionActionProviderContext
};

export class SessionActionsProvider {
  private readonly capabilities: CapabilityRegistry;

  public constructor(options: SessionActionsProviderOptions) {
    if ("capabilities" in options) {
      this.capabilities = options.capabilities;
      return;
    }

    const sessionIdentity = new SessionIdentityRegistry({
      runtimeService: options.runtimeService,
      sessionIndexStore: options.sessionIndexStore
    });
    this.capabilities = new CapabilityRegistry({
      runtimeService: options.runtimeService,
      sessionIndexStore: options.sessionIndexStore,
      sessionIdentity,
      capabilities: (options.providers ?? []).map(
        (provider): AgentWorkbenchCapabilities => ({
          agentId: provider.agentId,
          sessionActions: provider
        })
      )
    });
  }

  public async listActions(sessionId: string): Promise<SessionActionDescriptor[]> {
    return this.capabilities.listSessionActions(sessionId);
  }

  public async runAction(
    sessionId: string,
    action: SessionActionKind
  ): Promise<SessionActionResult> {
    return this.capabilities.runSessionAction(sessionId, action);
  }
}
