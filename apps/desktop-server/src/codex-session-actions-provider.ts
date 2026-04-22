import type { SessionIndexStore } from "./session-index.js";
import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import { createFilePathTarget } from "./file-path-target.js";
import type {
  SessionAgentActionsProvider,
  SessionActionDescriptor,
  SessionActionProviderContext,
  SessionActionResult
} from "./session-actions.js";

const resolveThreadId = (
  input: SessionActionProviderContext,
  codexRuntimePort: CodexAppServerRuntimePort
): string | undefined =>
  codexRuntimePort.getThreadIdForSession(input.sessionId) ??
  input.providerHandle?.providerSessionId ??
  input.indexEntry?.providerSessionId;

export class CodexSessionActionsProvider implements SessionAgentActionsProvider {
  public readonly engineId = "codex";

  private readonly codexRuntimePort: CodexAppServerRuntimePort;

  public constructor(options: { codexRuntimePort: CodexAppServerRuntimePort }) {
    this.codexRuntimePort = options.codexRuntimePort;
  }

  public resolveDisplayedSessionId(input: SessionActionProviderContext): string | undefined {
    return resolveThreadId(input, this.codexRuntimePort);
  }

  public async listAdditionalActions(
    input: SessionActionProviderContext
  ): Promise<SessionActionDescriptor[]> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    return [
      {
        action: "open_rollout",
        label: "Open rollout",
        disabled: !threadId,
        reason: threadId ? undefined : "Rollout is not available until the thread is created."
      }
    ];
  }

  public async prepareArchive(input: SessionActionProviderContext): Promise<void> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    if (!threadId) {
      throw new Error("Archive is unavailable without a provider session id.");
    }
    await this.codexRuntimePort.archiveThread(threadId);
  }

  public async runAction(
    input: SessionActionProviderContext & { action: import("./session-actions.js").SessionActionKind }
  ): Promise<SessionActionResult | undefined> {
    if (input.action !== "open_rollout") {
      return undefined;
    }
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    if (!threadId) {
      throw new Error("Rollout path is unavailable before the thread is created.");
    }
    const thread = await this.codexRuntimePort.readThread(threadId, false);
    if (!thread.path) {
      throw new Error("Codex thread does not expose a rollout path.");
    }
    const rolloutTarget = createFilePathTarget(thread.path);
    return {
      action: "open_rollout",
      rolloutPath: thread.path,
      rolloutDisplayPath: rolloutTarget.displayPath,
      rolloutFileUrl: rolloutTarget.fileUrl
    };
  }
}
