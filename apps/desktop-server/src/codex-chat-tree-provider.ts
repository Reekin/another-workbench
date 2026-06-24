import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import type {
  ChatTreeAgentProvider,
  ChatTreeProviderContext,
  ChatTreeSnapshot
} from "./chat-tree-provider.js";
import { resolveCodexThreadId } from "./codex-session-identity.js";

const toSafeNumber = (value: number | bigint): number => Number(value);

export class CodexChatTreeAgentProvider implements ChatTreeAgentProvider {
  public readonly engineId = "codex";

  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly now: () => string;

  public constructor(options: {
    codexRuntimePort: CodexAppServerRuntimePort;
    now?: () => string;
  }) {
    this.codexRuntimePort = options.codexRuntimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(input: ChatTreeProviderContext): Promise<ChatTreeSnapshot> {
    const threadId = resolveCodexThreadId(input);
    const chatTree = threadId
      ? await this.codexRuntimePort.readChatTree(threadId)
      : undefined;
    if (!chatTree) {
      return {
        sessionId: input.sessionId,
        engineId: this.engineId,
        supportsJump: false,
        nodes: [],
        fetchedAt: this.now()
      };
    }

    return {
      sessionId: input.sessionId,
      engineId: this.engineId,
      supportsJump: true,
      version: chatTree.chatTree.version,
      revision: toSafeNumber(chatTree.chatTree.revision),
      currentNodeId: chatTree.chatTree.currentNodeId ?? undefined,
      visibleNodeIds: [...chatTree.chatTree.visibleNodeIds],
      visibleTurnIds: [...chatTree.chatTree.visibleTurnIds],
      nodes: chatTree.chatTree.nodes.map((node) => ({
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId ?? undefined,
        label: node.summary ?? node.nodeId,
        summary: node.summary ?? undefined,
        turnId: node.turnId ?? undefined,
        order: toSafeNumber(node.order),
        isCurrent: chatTree.chatTree.currentNodeId === node.nodeId,
        status: node.status
      })),
      fetchedAt: this.now()
    };
  }

  public async jump(
    input: ChatTreeProviderContext,
    nodeId: string,
    expectedRevision?: number
  ): Promise<boolean> {
    const threadId = resolveCodexThreadId(input);
    if (!threadId) {
      return false;
    }
    await this.codexRuntimePort.setCurrentChatTreeNode(
      threadId,
      nodeId,
      expectedRevision
    );
    return true;
  }
}
