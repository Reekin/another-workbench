import type {
  DiagnosticsCapability,
  DiagnosticsSnapshot,
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

export class CodexDiagnosticsProvider implements DiagnosticsCapability {
  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly now: () => string;

  public constructor(options: {
    codexRuntimePort: CodexAppServerRuntimePort;
    now?: () => string;
  }) {
    this.codexRuntimePort = options.codexRuntimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async get(input: SessionCapabilityContext): Promise<DiagnosticsSnapshot> {
    const threadId = resolveThreadId(input, this.codexRuntimePort);
    const auth = await this.codexRuntimePort.readAuthStatus().catch(() => undefined);
    const thread = threadId
      ? await this.codexRuntimePort.readThread(threadId, false).catch(() => undefined)
      : undefined;
    const diffToRemote =
      thread?.cwd && thread.gitInfo?.branch
        ? await this.codexRuntimePort
            .readGitDiffToRemote(thread.cwd)
            .catch(() => undefined)
        : undefined;

    const summaryParts = [
      auth?.authMethod ? `auth=${auth.authMethod}` : undefined,
      thread?.gitInfo?.branch ? `branch=${thread.gitInfo.branch}` : undefined,
      diffToRemote?.sha ? `remote=${diffToRemote.sha}` : undefined
    ].filter((value): value is string => Boolean(value));

    return {
      sessionId: input.sessionId,
      engineId: input.engineId ?? "codex",
      supported: Boolean(auth || thread),
      authenticated: Boolean(auth?.authMethod),
      authMethod: auth?.authMethod ?? undefined,
      requiresOpenaiAuth: auth?.requiresOpenaiAuth ?? undefined,
      gitBranch: thread?.gitInfo?.branch ?? undefined,
      gitSha: thread?.gitInfo?.sha ?? undefined,
      diffToRemoteSha: diffToRemote?.sha ?? undefined,
      diffToRemote: diffToRemote?.diff ?? undefined,
      summaryText: summaryParts.length > 0 ? summaryParts.join(" · ") : undefined,
      fetchedAt: this.now()
    };
  }
}
