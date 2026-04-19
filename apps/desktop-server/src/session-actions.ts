import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { SessionIndexEntry, SessionIndexStore } from "./session-index.js";
import {
  resolveSessionContext,
  type ResolvedSessionContext
} from "./session-provider-context.js";

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
  | {
      action: "open_rollout";
      rolloutPath: string;
      rolloutDisplayPath: string;
      rolloutFileUrl: string;
    }
  | { action: "reload"; resumed: true };

type SessionActionsProviderOptions = {
  runtimeService: WorkbenchRuntimeService;
  sessionIndexStore: SessionIndexStore;
  providers?: SessionAgentActionsProvider[];
};

export type SessionActionProviderContext = ResolvedSessionContext & {
  runtimeService: WorkbenchRuntimeService;
  sessionIndexStore: SessionIndexStore;
};

export type SessionAgentActionsProvider = {
  readonly agentId: string;
  resolveDisplayedSessionId?: (input: SessionActionProviderContext) => string | undefined;
  listAdditionalActions?: (
    input: SessionActionProviderContext
  ) => Promise<SessionActionDescriptor[]>;
  prepareArchive?: (input: SessionActionProviderContext) => Promise<void>;
  runAction?: (
    input: SessionActionProviderContext & { action: SessionActionKind }
  ) => Promise<SessionActionResult | undefined>;
};

export class SessionActionsProvider {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly providersByAgentId: Map<string, SessionAgentActionsProvider>;

  public constructor(options: SessionActionsProviderOptions) {
    this.runtimeService = options.runtimeService;
    this.sessionIndexStore = options.sessionIndexStore;
    this.providersByAgentId = new Map(
      (options.providers ?? []).map((provider) => [provider.agentId, provider])
    );
  }

  public async listActions(sessionId: string): Promise<SessionActionDescriptor[]> {
    const context = this.resolveContext(sessionId);
    const { session, indexEntry } = context;
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

    const provider = this.resolveProvider(context.agentId);
    if (provider?.listAdditionalActions) {
      actions.push(...(await provider.listAdditionalActions(context)));
    }

    return actions;
  }

  public async runAction(
    sessionId: string,
    action: SessionActionKind
  ): Promise<SessionActionResult> {
    const context = this.resolveContext(sessionId);
    const { session, indexEntry } = context;
    if (!session && !indexEntry && action !== "copy_session_id") {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const provider = this.resolveProvider(context.agentId);
    switch (action) {
      case "copy_session_id":
        return {
          action,
          copiedText:
            provider?.resolveDisplayedSessionId?.(context) ??
            indexEntry?.providerSessionId ??
            sessionId
        };
      case "archive":
        await provider?.prepareArchive?.(context);
        await this.archiveProviderAliases(context);
        if (!session && indexEntry) {
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
        const result = await provider?.runAction?.({
          ...context,
          action
        });
        if (result) {
          return result;
        }
        throw new Error(
          `Open rollout is not supported for ${context.agentId ?? "unknown"} sessions.`
        );
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  private resolveContext(sessionId: string): SessionActionProviderContext {
    return {
      ...resolveSessionContext(this.runtimeService, this.sessionIndexStore, sessionId),
      runtimeService: this.runtimeService,
      sessionIndexStore: this.sessionIndexStore
    };
  }

  private resolveProvider(
    agentId: string | undefined
  ): SessionAgentActionsProvider | undefined {
    return agentId ? this.providersByAgentId.get(agentId) : undefined;
  }

  private async archiveProviderAliases(
    context: SessionActionProviderContext
  ): Promise<void> {
    const providerSessionId = this.resolveProviderSessionId(context);
    if (!providerSessionId) {
      if (context.indexEntry) {
        await this.sessionIndexStore.archiveSession(context.sessionId);
      }
      return;
    }
    const aliases = this.sessionIndexStore
      .listEntriesByProviderSessionId(providerSessionId, context.indexEntry?.workspaceId)
      .map((entry) => entry.sessionId);
    if (aliases.length === 0 && context.indexEntry) {
      await this.sessionIndexStore.archiveSession(context.sessionId);
      return;
    }
    await this.sessionIndexStore.archiveSessions(aliases);
  }

  private resolveProviderSessionId(
    context: SessionActionProviderContext
  ): string | undefined {
    if (context.indexEntry?.providerSessionId) {
      return context.indexEntry.providerSessionId;
    }
    const metadata = context.session?.metadata;
    const providerSessionId = metadata?.providerSessionId;
    return typeof providerSessionId === "string" && providerSessionId.trim().length > 0
      ? providerSessionId
      : undefined;
  }
}
