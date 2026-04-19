import type { SessionIndexStore } from "./session-index.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import {
  resolveSessionContext,
  type ResolvedSessionContext
} from "./session-provider-context.js";

export type ChatTreeNodeSnapshot = {
  nodeId: string;
  parentNodeId?: string;
  label: string;
  turnId?: string;
  order: number;
  isCurrent: boolean;
};

export type ChatTreeSnapshot = {
  sessionId: string;
  agentId: string;
  supportsJump: boolean;
  currentNodeId?: string;
  nodes: ChatTreeNodeSnapshot[];
  fetchedAt: string;
};

type ChatTreeProviderOptions = {
  runtimeService: WorkbenchRuntimeService;
  sessionIndexStore: SessionIndexStore;
  providers?: ChatTreeAgentProvider[];
  now?: () => string;
};

export type ChatTreeProviderContext = ResolvedSessionContext & {
  runtimeService: WorkbenchRuntimeService;
  sessionIndexStore: SessionIndexStore;
};

export type ChatTreeAgentProvider = {
  readonly agentId: string;
  get: (input: ChatTreeProviderContext) => Promise<ChatTreeSnapshot>;
  jump: (input: ChatTreeProviderContext, nodeId: string) => Promise<boolean>;
};

export class ChatTreeProvider {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly providersByAgentId: Map<string, ChatTreeAgentProvider>;
  private readonly now: () => string;

  public constructor(options: ChatTreeProviderOptions) {
    this.runtimeService = options.runtimeService;
    this.sessionIndexStore = options.sessionIndexStore;
    this.providersByAgentId = new Map(
      (options.providers ?? []).map((provider) => [provider.agentId, provider])
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(sessionId: string): Promise<ChatTreeSnapshot> {
    const context = this.resolveContext(sessionId);

    if (!context.agentId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const provider = this.providersByAgentId.get(context.agentId);
    if (provider) {
      return provider.get(context);
    }

    return {
      sessionId,
      agentId: context.agentId,
      supportsJump: false,
      nodes: [],
      fetchedAt: this.now()
    };
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    const context = this.resolveContext(sessionId);
    if (!context.agentId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const provider = this.providersByAgentId.get(context.agentId);
    if (!provider) {
      return {
        jumped: false
      };
    }
    return {
      jumped: await provider.jump(context, nodeId)
    };
  }

  private resolveContext(sessionId: string): ChatTreeProviderContext {
    return {
      ...resolveSessionContext(this.runtimeService, this.sessionIndexStore, sessionId),
      runtimeService: this.runtimeService,
      sessionIndexStore: this.sessionIndexStore
    };
  }
}
