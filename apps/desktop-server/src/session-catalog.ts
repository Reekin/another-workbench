import type {
  ChatSession,
  DomainSnapshot,
  ProviderSessionHandle,
  SessionRelation
} from "@another-workbench/shared";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type {
  SessionIndexEntry,
  SessionIndexStore,
  SessionRelationIndex
} from "./session-index.js";
import type {
  WorkspaceRecord,
  WorkspaceRegistryService
} from "./workspace-registry.js";

export type SessionStatusDot = "none" | "running" | "unread_completed";

export type SessionBrowserNode = {
  sessionId: string;
  displaySessionId: string;
  providerSessionId?: string;
  providerHandle?: ProviderSessionHandle;
  workspaceId: string;
  conversationId?: string;
  engineId: string;
  title: string;
  summaryText?: string;
  statusDot: SessionStatusDot;
  isExpanded: boolean;
  isActive: boolean;
  isArchived: boolean;
  parentSessionId?: string;
  children: SessionBrowserNode[];
  updatedAt: string;
  lastCompletedTurnAt?: string;
};

export type WorkspaceBrowserNode = {
  workspaceId: string;
  label: string;
  rootPath: string;
  isExpanded: boolean;
  isActive: boolean;
  sessions: SessionBrowserNode[];
};

type SessionCatalogServiceOptions = {
  runtimeService: WorkbenchRuntimeService;
  workspaceRegistry: WorkspaceRegistryService;
  sessionIndexStore: SessionIndexStore;
};

type SessionCatalogSeed = {
  sessionId: string;
  providerKind?: string;
  providerSessionId?: string;
  workspaceId: string;
  conversationId?: string;
  engineId: string;
  title?: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
  lastCompletedTurnAt?: string;
  archivedAt?: string;
  runtimeStatus?: ChatSession["status"];
  unreadState?: SessionIndexEntry["unreadState"];
};

const compareSeedLastCompletedTurnAtDesc = (
  left: SessionCatalogSeed,
  right: SessionCatalogSeed
): number => {
  const leftSortAt = left.lastCompletedTurnAt ?? left.createdAt;
  const rightSortAt = right.lastCompletedTurnAt ?? right.createdAt;
  const bySortAt = rightSortAt.localeCompare(leftSortAt);
  if (bySortAt !== 0) {
    return bySortAt;
  }
  return left.sessionId.localeCompare(right.sessionId);
};

const collectLastCompletedTurnAtBySessionId = (
  turns: DomainSnapshot["turns"]
): Map<string, string> => {
  const lastCompletedTurnAtBySessionId = new Map<string, string>();
  for (const turn of turns) {
    if (turn.status !== "completed" || !turn.completedAt) {
      continue;
    }
    const existing = lastCompletedTurnAtBySessionId.get(turn.sessionId);
    if (!existing || turn.completedAt > existing) {
      lastCompletedTurnAtBySessionId.set(turn.sessionId, turn.completedAt);
    }
  }
  return lastCompletedTurnAtBySessionId;
};

const relationKey = (
  parentSessionId: string,
  childSessionId: string,
  relationType: string
): string => `${parentSessionId}:${childSessionId}:${relationType}`;

const toSeedFromRuntime = (
  snapshot: DomainSnapshot,
  session: ChatSession,
  lastCompletedTurnAtBySessionId: ReadonlyMap<string, string>
): SessionCatalogSeed | undefined => {
  const conversation = snapshot.conversations.find(
    (item) => item.conversationId === session.conversationId
  );
  if (!conversation?.workspaceId) {
    return undefined;
  }
  return {
    sessionId: session.sessionId,
    workspaceId: conversation.workspaceId,
    conversationId: session.conversationId,
    engineId: session.engineId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastCompletedTurnAt: lastCompletedTurnAtBySessionId.get(session.sessionId),
    archivedAt: session.archivedAt,
    runtimeStatus: session.status
  };
};

const isBrowserVisibleSeed = (
  seed: SessionCatalogSeed,
  runtimeSessionIds: ReadonlySet<string>
): boolean =>
  !seed.archivedAt &&
  (runtimeSessionIds.has(seed.sessionId) || Boolean(seed.providerSessionId));

export class SessionCatalogService {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly workspaceRegistry: WorkspaceRegistryService;
  private readonly sessionIndexStore: SessionIndexStore;

  public constructor(options: SessionCatalogServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
  }

  public async listWorkspaceTree(workspaceId?: string): Promise<WorkspaceBrowserNode[]> {
    await this.workspaceRegistry.ready();
    await this.sessionIndexStore.ready();
    const snapshot = this.runtimeService.getSnapshot();
    const registryState = this.workspaceRegistry.getState();
    const indexState = this.sessionIndexStore.getState();
    const runtimeSessionIds = new Set(snapshot.sessions.map((session) => session.sessionId));
    const lastCompletedTurnAtBySessionId = collectLastCompletedTurnAtBySessionId(snapshot.turns);
    const runtimeSeeds = snapshot.sessions
      .map((session) =>
        toSeedFromRuntime(snapshot, session, lastCompletedTurnAtBySessionId)
      )
      .filter((seed): seed is SessionCatalogSeed => Boolean(seed));
    const bySessionId = new Map<string, SessionCatalogSeed>();

    for (const entry of indexState.entries) {
      bySessionId.set(entry.sessionId, {
        sessionId: entry.sessionId,
        providerKind: entry.providerKind,
        providerSessionId: entry.providerSessionId,
        workspaceId: entry.workspaceId,
        conversationId: entry.conversationId,
        engineId: entry.engineId,
        title: entry.title,
        summaryText: entry.summaryText,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastCompletedTurnAt: entry.lastCompletedTurnAt,
        archivedAt: entry.archivedAt,
        unreadState: entry.unreadState
      });
    }
    for (const runtimeSeed of runtimeSeeds) {
      const existing = bySessionId.get(runtimeSeed.sessionId);
      bySessionId.set(runtimeSeed.sessionId, {
        ...existing,
        ...runtimeSeed,
        lastCompletedTurnAt:
          runtimeSeed.lastCompletedTurnAt ?? existing?.lastCompletedTurnAt,
        summaryText: existing?.summaryText,
        unreadState: existing?.unreadState
      });
    }

    const relations = this.mergeRelations(snapshot.sessionRelations, indexState.relations);
    const childrenByParentId = new Map<string, string[]>();
    const parentByChildId = new Map<string, string>();
    for (const relation of relations) {
      childrenByParentId.set(relation.parentSessionId, [
        ...(childrenByParentId.get(relation.parentSessionId) ?? []),
        relation.childSessionId
      ]);
      if (!parentByChildId.has(relation.childSessionId)) {
        parentByChildId.set(relation.childSessionId, relation.parentSessionId);
      }
    }

    const activeWorkspaceId = registryState.lastActiveWorkspaceId;
    const activeSessionId = registryState.lastActiveSessionId;

    return registryState.workspaces
      .filter((workspace) => !workspaceId || workspace.workspaceId === workspaceId)
      .map((workspace) => {
      const workspaceSeeds = [...bySessionId.values()].filter(
        (seed) =>
          seed.workspaceId === workspace.workspaceId &&
          isBrowserVisibleSeed(seed, runtimeSessionIds)
      );
      const roots = workspaceSeeds
        .filter((seed) => !parentByChildId.has(seed.sessionId))
        .sort(compareSeedLastCompletedTurnAtDesc);

      return {
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        rootPath: workspace.absolutePath,
        isExpanded: registryState.expandedWorkspaceIds.includes(workspace.workspaceId),
        isActive: activeWorkspaceId === workspace.workspaceId,
        sessions: roots.map((seed) =>
          this.buildSessionNode({
            seed,
            bySessionId,
            childrenByParentId,
            expandedSessionIds: registryState.expandedSessionIds,
            activeSessionId
          })
        )
      };
      });
  }

  public async markSessionRead(sessionId: string): Promise<void> {
    await this.sessionIndexStore.markSessionRead(sessionId);
  }

  private mergeRelations(
    runtimeRelations: SessionRelation[],
    indexRelations: SessionRelationIndex[]
  ): Array<{
    parentSessionId: string;
    childSessionId: string;
    relationType: string;
  }> {
    const merged = new Map<string, {
      parentSessionId: string;
      childSessionId: string;
      relationType: string;
    }>();
    for (const relation of runtimeRelations) {
      merged.set(
        relationKey(
          relation.parentSessionId,
          relation.childSessionId,
          relation.relationType
        ),
        {
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType
        }
      );
    }
    for (const relation of indexRelations) {
      merged.set(
        relationKey(
          relation.parentSessionId,
          relation.childSessionId,
          relation.relationType
        ),
        {
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType
        }
      );
    }
    return [...merged.values()];
  }

  private buildSessionNode(input: {
    seed: SessionCatalogSeed;
    bySessionId: Map<string, SessionCatalogSeed>;
    childrenByParentId: Map<string, string[]>;
    expandedSessionIds: string[];
    activeSessionId?: string;
    parentSessionId?: string;
  }): SessionBrowserNode {
    const childIds = input.childrenByParentId.get(input.seed.sessionId) ?? [];
    const children = childIds
      .map((childId) => input.bySessionId.get(childId))
      .filter(
        (seed): seed is SessionCatalogSeed => Boolean(seed && !seed.archivedAt)
      )
      .sort(compareSeedLastCompletedTurnAtDesc)
      .map((seed) =>
        this.buildSessionNode({
          ...input,
          seed,
          parentSessionId: input.seed.sessionId
        })
      );

    return {
      sessionId: input.seed.sessionId,
      displaySessionId: input.seed.providerSessionId ?? input.seed.sessionId,
      providerSessionId: input.seed.providerSessionId,
      providerHandle:
        input.seed.providerKind && input.seed.providerSessionId
          ? {
              providerKind: input.seed.providerKind,
              providerSessionId: input.seed.providerSessionId
            }
          : undefined,
      workspaceId: input.seed.workspaceId,
      conversationId: input.seed.conversationId,
      engineId: input.seed.engineId,
      title: input.seed.title ?? input.seed.sessionId,
      summaryText: input.seed.summaryText,
      statusDot:
        input.seed.runtimeStatus === "running" ||
        input.seed.runtimeStatus === "awaiting_approval"
          ? "running"
          : input.activeSessionId === input.seed.sessionId
            ? "none"
          : input.seed.unreadState === "unread_completed"
            ? "unread_completed"
            : "none",
      isExpanded: input.expandedSessionIds.includes(input.seed.sessionId),
      isActive: input.activeSessionId === input.seed.sessionId,
      isArchived: Boolean(input.seed.archivedAt),
      parentSessionId: input.parentSessionId,
      children,
      updatedAt: input.seed.updatedAt,
      lastCompletedTurnAt: input.seed.lastCompletedTurnAt
    };
  }
}
