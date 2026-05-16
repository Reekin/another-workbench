import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import { createFilePathTarget } from "./file-path-target.js";
import type {
  SessionAgentActionsProvider,
  SessionActionDescriptor,
  SessionActionKind,
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
    input: SessionActionProviderContext & { action: SessionActionKind }
  ): Promise<SessionActionResult | undefined> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);

    if (input.action === "refresh") {
      await this.codexRuntimePort.reloadUserConfig();
      await this.codexRuntimePort.reloadMcpServers();
      await this.codexRuntimePort.listSkills({
        forceReload: true
      });
      return {
        action: "refresh",
        refreshed: true,
        details: "Reloaded user config, refreshed skills, and queued MCP server reloads for loaded Codex threads."
      };
    }

    if (input.action === "resume") {
      if (!threadId) {
        throw new Error("Resume is unavailable without a provider thread id.");
      }
      await this.codexRuntimePort.interruptThread(threadId, {
        bestEffort: true
      });
      await this.codexRuntimePort.unsubscribeThread(threadId);
      const thread = await this.codexRuntimePort.resumeThread(threadId);
      this.codexRuntimePort.attachThreadToSession(input.sessionId, thread.id);
      return {
        action: "resume",
        resumed: true
      };
    }

    if (input.action !== "open_rollout") {
      return undefined;
    }

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
