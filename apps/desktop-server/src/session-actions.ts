import type { ChatSession } from "@another-workbench/shared";
import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { SessionIndexStore } from "./session-index.js";

export type SessionActionKind =
  | "archive"
  | "copy_session_id"
  | "open_rollout"
  | "reload";

export type SessionActionDescriptor = {
  action: SessionActionKind;
  label: string;
  disabled?: boolean;
  reason?: string;
};

export type SessionActionResult =
  | { action: "archive"; archived: true }
  | { action: "copy_session_id"; copiedText: string }
  | { action: "open_rollout"; rolloutPath: string }
  | { action: "reload"; resumed: true };

type SessionActionsProviderOptions = {
  runtimeService: WorkbenchRuntimeService;
  codexRuntimePort: CodexAppServerRuntimePort;
  sessionIndexStore: SessionIndexStore;
};

const findSession = (
  runtimeService: WorkbenchRuntimeService,
  sessionId: string
): ChatSession | undefined =>
  runtimeService
    .listSessions({
      includeArchived: true
    })
    .find((session) => session.sessionId === sessionId);

const resolveDisplayedSessionId = (
  sessionId: string,
  runtimeService: WorkbenchRuntimeService,
  codexRuntimePort: CodexAppServerRuntimePort,
  sessionIndexStore: SessionIndexStore
): string => {
  const runtimeSession = findSession(runtimeService, sessionId);
  const indexEntry = sessionIndexStore.getEntry(sessionId);
  const agentId = runtimeSession?.agentId ?? indexEntry?.agentId;
  if (agentId === "codex") {
    return (
      codexRuntimePort.getThreadIdForSession(sessionId) ??
      indexEntry?.providerSessionId ??
      sessionId
    );
  }
  return indexEntry?.providerSessionId ?? sessionId;
};

export class SessionActionsProvider {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly sessionIndexStore: SessionIndexStore;

  public constructor(options: SessionActionsProviderOptions) {
    this.runtimeService = options.runtimeService;
    this.codexRuntimePort = options.codexRuntimePort;
    this.sessionIndexStore = options.sessionIndexStore;
  }

  public async listActions(sessionId: string): Promise<SessionActionDescriptor[]> {
    const session = findSession(this.runtimeService, sessionId);
    const indexEntry = this.sessionIndexStore.getEntry(sessionId);
    const actions: SessionActionDescriptor[] = [
      {
        action: "copy_session_id",
        label: "Copy session id"
      }
    ];
    if (!session && !indexEntry) {
      return actions;
    }

    actions.push({
      action: "archive",
      label: "Archive",
      disabled: Boolean(session?.archivedAt ?? indexEntry?.archivedAt),
      reason:
        session?.archivedAt ?? indexEntry?.archivedAt
          ? "Session is already archived."
          : undefined
    });
    actions.push({
      action: "reload",
      label: "Reload"
    });

    const agentId = session?.agentId ?? indexEntry?.agentId;
    if (agentId === "codex") {
      const threadId =
        this.codexRuntimePort.getThreadIdForSession(sessionId) ??
        indexEntry?.providerSessionId;
      actions.push({
        action: "open_rollout",
        label: "Open rollout",
        disabled: !threadId,
        reason: threadId ? undefined : "Rollout is not available until the thread is created."
      });
    }

    return actions;
  }

  public async runAction(
    sessionId: string,
    action: SessionActionKind
  ): Promise<SessionActionResult> {
    const session = findSession(this.runtimeService, sessionId);
    const indexEntry = this.sessionIndexStore.getEntry(sessionId);
    if (!session && !indexEntry && action !== "copy_session_id") {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    switch (action) {
      case "copy_session_id":
        return {
          action,
          copiedText: resolveDisplayedSessionId(
            sessionId,
            this.runtimeService,
            this.codexRuntimePort,
            this.sessionIndexStore
          )
        };
      case "archive":
        if (!session && indexEntry?.agentId === "codex") {
          const threadId = indexEntry.providerSessionId;
          if (!threadId) {
            throw new Error("Archive is unavailable without a provider session id.");
          }
          await this.codexRuntimePort.archiveThread(threadId);
          await this.sessionIndexStore.archiveSession(sessionId);
          return {
            action,
            archived: true
          };
        }
        await this.runtimeService.executeCommand({
          commandId: `archive-${sessionId}`,
          command: {
            type: "archiveSession",
            sessionId
          }
        });
        return {
          action,
          archived: true
        };
      case "reload":
        if (!session && indexEntry) {
          return {
            action,
            resumed: true
          };
        }
        await this.runtimeService.executeCommand({
          commandId: `resume-${sessionId}`,
          command: {
            type: "resumeSession",
            sessionId
          }
        });
        return {
          action,
          resumed: true
        };
      case "open_rollout": {
        const agentId = session?.agentId ?? indexEntry?.agentId;
        if (agentId !== "codex") {
          throw new Error(`Open rollout is not supported for ${agentId ?? "unknown"} sessions.`);
        }
        const threadId =
          this.codexRuntimePort.getThreadIdForSession(sessionId) ??
          indexEntry?.providerSessionId;
        if (!threadId) {
          throw new Error("Rollout path is unavailable before the thread is created.");
        }
        const thread = await this.codexRuntimePort.readThread(threadId, false);
        if (!thread.path) {
          throw new Error("Codex thread does not expose a rollout path.");
        }
        return {
          action,
          rolloutPath: thread.path
        };
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }
}
