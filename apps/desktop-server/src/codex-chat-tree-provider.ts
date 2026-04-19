import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import type {
  ChatTreeAgentProvider,
  ChatTreeProviderContext,
  ChatTreeSnapshot
} from "./chat-tree-provider.js";

const resolveThreadId = (
  input: ChatTreeProviderContext,
  codexRuntimePort: CodexAppServerRuntimePort
): string | undefined =>
  codexRuntimePort.getThreadIdForSession(input.sessionId) ??
  input.providerHandle?.providerSessionId ??
  input.indexEntry?.providerSessionId;

export class CodexChatTreeAgentProvider implements ChatTreeAgentProvider {
  public readonly agentId = "codex";

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
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    const chatTree = threadId
      ? await this.codexRuntimePort.readChatTree(threadId)
      : undefined;
    if (!chatTree) {
      return {
        sessionId: input.sessionId,
        agentId: this.agentId,
        supportsJump: false,
        nodes: [],
        fetchedAt: this.now()
      };
    }

    return {
      sessionId: input.sessionId,
      agentId: this.agentId,
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

  public async jump(
    input: ChatTreeProviderContext,
    nodeId: string
  ): Promise<boolean> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    if (!threadId) {
      return false;
    }
    await this.codexRuntimePort.setCurrentChatTreeNode(threadId, nodeId);
    return true;
  }
}
