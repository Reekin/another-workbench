import {
  CapabilityRegistry,
  type AgentWorkbenchCapabilities,
  type ConversationGraphCapability,
  type ConversationGraphSnapshot as ChatTreeSnapshot,
  type ConversationGraphNodeSnapshot as ChatTreeNodeSnapshot,
  type SessionCapabilityContext as ChatTreeProviderContext
} from "./capability-registry.js";
import type { SessionIndexStore } from "./session-index.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";

type ChatTreeProviderOptions =
  | {
      capabilities: CapabilityRegistry;
    }
  | {
      runtimeService: WorkbenchRuntimeService;
      sessionIndexStore: SessionIndexStore;
      providers?: ChatTreeAgentProvider[];
      now?: () => string;
    };

export type ChatTreeAgentProvider = ConversationGraphCapability & {
  readonly engineId: string;
};

export type {
  ChatTreeNodeSnapshot,
  ChatTreeProviderContext,
  ChatTreeSnapshot
};

export class ChatTreeProvider {
  private readonly capabilities: CapabilityRegistry;

  public constructor(options: ChatTreeProviderOptions) {
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
          engineId: provider.engineId,
          conversationGraph: provider
        })
      ),
      now: options.now
    });
  }

  public async get(sessionId: string): Promise<ChatTreeSnapshot> {
    return this.capabilities.getConversationGraph(sessionId);
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    return this.capabilities.jumpConversationGraph(sessionId, nodeId);
  }
}
