import type {
  CheckpointCapability,
  CheckpointSnapshot,
  SessionCapabilityContext
} from "./capability-registry.js";
import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";

const resolveThreadId = (
  input: SessionCapabilityContext,
  codexRuntimePort: CodexAppServerRuntimePort
): string | undefined =>
  codexRuntimePort.getThreadIdForSession(input.sessionId) ??
  input.providerHandle?.providerSessionId ??
  input.indexEntry?.providerSessionId;

const toSafeNumber = (value: number | bigint): number => Number(value);

export class CodexCheckpointProvider implements CheckpointCapability {
  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly now: () => string;

  public constructor(options: {
    codexRuntimePort: CodexAppServerRuntimePort;
    now?: () => string;
  }) {
    this.codexRuntimePort = options.codexRuntimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(input: SessionCapabilityContext): Promise<CheckpointSnapshot> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    if (!threadId) {
      return {
        sessionId: input.sessionId,
        engineId: input.engineId ?? "codex",
        supported: false,
        supportsRestore: false,
        checkpoints: [],
        fetchedAt: this.now()
      };
    }

    const chatTree = await this.codexRuntimePort.readChatTree(threadId);
    return {
      sessionId: input.sessionId,
      engineId: input.engineId ?? "codex",
      supported: true,
      supportsRestore: true,
      currentCheckpointId: chatTree.chatTree.currentNodeId ?? undefined,
      checkpoints: chatTree.chatTree.nodes.map((node) => ({
        checkpointId: node.nodeId,
        providerCheckpointId: node.nodeId,
        label: node.summary ?? node.nodeId,
        summary: node.summary ?? undefined,
        turnId: node.turnId ?? undefined,
        order: toSafeNumber(node.order),
        isCurrent: chatTree.chatTree.currentNodeId === node.nodeId
      })),
      fetchedAt: this.now()
    };
  }
}
