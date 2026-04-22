import type {
  SessionCapabilityContext,
  WorktreeCapability,
  WorktreeSnapshot
} from "./capability-registry.js";
import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";

const resolveThreadId = (
  input: SessionCapabilityContext,
  codexRuntimePort: CodexAppServerRuntimePort
): string | undefined =>
  codexRuntimePort.getThreadIdForSession(input.sessionId) ??
  input.providerHandle?.providerSessionId ??
  input.indexEntry?.providerSessionId;

export class CodexWorktreeProvider implements WorktreeCapability {
  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly now: () => string;

  public constructor(options: {
    codexRuntimePort: CodexAppServerRuntimePort;
    now?: () => string;
  }) {
    this.codexRuntimePort = options.codexRuntimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(input: SessionCapabilityContext): Promise<WorktreeSnapshot> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    if (!threadId) {
      return {
        sessionId: input.sessionId,
        engineId: input.engineId ?? "codex",
        supported: false,
        fetchedAt: this.now()
      };
    }

    const thread = await this.codexRuntimePort.readThread(threadId, false);
    const diffToRemote =
      thread.cwd && thread.gitInfo?.branch
        ? await this.codexRuntimePort
            .readGitDiffToRemote(thread.cwd)
            .catch(() => undefined)
        : undefined;

    return {
      sessionId: input.sessionId,
      engineId: input.engineId ?? "codex",
      supported: true,
      workspaceRoot: thread.cwd || undefined,
      rolloutPath: thread.path ?? undefined,
      gitBranch: thread.gitInfo?.branch ?? undefined,
      gitSha: thread.gitInfo?.sha ?? undefined,
      gitOriginUrl: thread.gitInfo?.originUrl ?? undefined,
      diffToRemoteSha: diffToRemote?.sha ?? undefined,
      diffToRemote: diffToRemote?.diff ?? undefined,
      fetchedAt: this.now()
    };
  }
}
