import type { ChatSession, ProviderSessionHandle } from "@another-workbench/shared";
import type { SessionIndexEntry, SessionIndexStore } from "./session-index.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";

const trimToUndefined = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const metadataProviderHandle = (
  session: ChatSession | undefined
): ProviderSessionHandle | undefined => {
  const providerKind = trimToUndefined(
    typeof session?.metadata?.providerKind === "string"
      ? session.metadata.providerKind
      : undefined
  );
  const providerSessionId = trimToUndefined(
    typeof session?.metadata?.providerSessionId === "string"
      ? session.metadata.providerSessionId
      : undefined
  );
  if (!providerKind || !providerSessionId) {
    return undefined;
  }
  return {
    providerKind,
    providerSessionId
  };
};

const handlesMatch = (
  left: ProviderSessionHandle | undefined,
  right: ProviderSessionHandle | undefined
): boolean =>
  Boolean(
    left &&
      right &&
      left.providerKind === right.providerKind &&
      left.providerSessionId === right.providerSessionId
  );

export type ResolvedSessionContext = {
  sessionId: string;
  session?: ChatSession;
  indexEntry?: SessionIndexEntry;
  agentId?: string;
  providerHandle?: ProviderSessionHandle;
};

export class SessionIdentityRegistry {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly sessionIndexStore: SessionIndexStore;

  public constructor(options: {
    runtimeService: WorkbenchRuntimeService;
    sessionIndexStore: SessionIndexStore;
  }) {
    this.runtimeService = options.runtimeService;
    this.sessionIndexStore = options.sessionIndexStore;
  }

  public findRuntimeSession(sessionId: string): ChatSession | undefined {
    return this.runtimeService
      .listSessions({
        includeArchived: true
      })
      .find((session) => session.sessionId === sessionId);
  }

  public getProviderHandle(sessionId: string): ProviderSessionHandle | undefined {
    const session = this.findRuntimeSession(sessionId);
    const runtimeHandle = this.runtimeService.resolveProviderSessionHandle?.(sessionId);
    if (runtimeHandle) {
      return runtimeHandle;
    }

    const indexEntry = this.sessionIndexStore.getEntry(sessionId);
    if (indexEntry?.providerKind && indexEntry.providerSessionId) {
      return {
        providerKind: indexEntry.providerKind,
        providerSessionId: indexEntry.providerSessionId
      };
    }

    return metadataProviderHandle(session);
  }

  public resolveContext(sessionId: string): ResolvedSessionContext {
    const session = this.findRuntimeSession(sessionId);
    const indexEntry = this.sessionIndexStore.getEntry(sessionId);
    return {
      sessionId,
      session,
      indexEntry,
      agentId: session?.agentId ?? indexEntry?.agentId,
      providerHandle:
        this.runtimeService.resolveProviderSessionHandle?.(sessionId) ??
        (indexEntry?.providerKind && indexEntry.providerSessionId
          ? {
              providerKind: indexEntry.providerKind,
              providerSessionId: indexEntry.providerSessionId
            }
          : undefined) ??
        metadataProviderHandle(session)
    };
  }

  public listSessionIdsByProviderHandle(
    handle: ProviderSessionHandle,
    workspaceId?: string
  ): string[] {
    const sessionIds = new Set<string>();

    for (const entry of this.sessionIndexStore.listEntries(workspaceId)) {
      if (
        entry.providerKind === handle.providerKind &&
        entry.providerSessionId === handle.providerSessionId
      ) {
        sessionIds.add(entry.sessionId);
      }
    }

    for (const session of this.runtimeService.listSessions({ includeArchived: true })) {
      const sessionHandle =
        this.runtimeService.resolveProviderSessionHandle?.(session.sessionId) ??
        metadataProviderHandle(session);
      if (handlesMatch(sessionHandle, handle)) {
        sessionIds.add(session.sessionId);
      }
    }

    return [...sessionIds];
  }

  public resolveWorkbenchSessionId(
    handle: ProviderSessionHandle,
    workspaceId?: string
  ): string | undefined {
    return this.listSessionIdsByProviderHandle(handle, workspaceId)[0];
  }
}
