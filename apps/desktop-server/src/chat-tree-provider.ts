import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import type { SessionIndexStore } from "./session-index.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";

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
  codexRuntimePort: CodexAppServerRuntimePort;
  sessionIndexStore: SessionIndexStore;
  now?: () => string;
};

export class ChatTreeProvider {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly now: () => string;

  public constructor(options: ChatTreeProviderOptions) {
    this.runtimeService = options.runtimeService;
    this.codexRuntimePort = options.codexRuntimePort;
    this.sessionIndexStore = options.sessionIndexStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(sessionId: string): Promise<ChatTreeSnapshot> {
    const session = this.resolveSession(sessionId);

    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    if (session.agentId !== "codex") {
      return {
        sessionId,
        agentId: session.agentId,
        supportsJump: false,
        nodes: [],
        fetchedAt: this.now()
      };
    }

    const threadId =
      this.codexRuntimePort.getThreadIdForSession(sessionId) ??
      this.sessionIndexStore.getEntry(sessionId)?.providerSessionId;
    const chatTree = threadId
      ? await this.codexRuntimePort.readChatTree(threadId)
      : undefined;
    if (!chatTree) {
      return {
        sessionId,
        agentId: session.agentId,
        supportsJump: false,
        nodes: [],
        fetchedAt: this.now()
      };
    }

    return {
      sessionId,
      agentId: session.agentId,
      supportsJump: true,
      currentNodeId: chatTree.chatTree.currentNodeId ?? undefined,
      nodes: chatTree.chatTree.nodes.map((node) => ({
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId ?? undefined,
        label: node.summary ?? node.nodeId,
        turnId: node.turnId ?? undefined,
        order: node.order,
        isCurrent: chatTree.chatTree.currentNodeId === node.nodeId
      })),
      fetchedAt: this.now()
    };
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    const session = this.resolveSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (session.agentId !== "codex") {
      return {
        jumped: false
      };
    }
    const threadId =
      this.codexRuntimePort.getThreadIdForSession(sessionId) ??
      this.sessionIndexStore.getEntry(sessionId)?.providerSessionId;
    if (!threadId) {
      return {
        jumped: false
      };
    }
    if (this.codexRuntimePort.getThreadIdForSession(sessionId)) {
      await this.codexRuntimePort.setCurrentChatTreeNodeForSession(sessionId, nodeId);
    } else {
      await this.codexRuntimePort.setCurrentChatTreeNode(threadId, nodeId);
    }
    return {
      jumped: true
    };
  }

  private resolveSession(sessionId: string): { sessionId: string; agentId: string } | undefined {
    const runtimeSession = this.runtimeService
      .listSessions({
        includeArchived: true
      })
      .find((item) => item.sessionId === sessionId);
    if (runtimeSession) {
      return runtimeSession;
    }
    const indexEntry = this.sessionIndexStore.getEntry(sessionId);
    if (!indexEntry) {
      return undefined;
    }
    return {
      sessionId,
      agentId: indexEntry.agentId
    };
  }
}
