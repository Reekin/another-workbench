import type {
  ChatSession,
  DomainSnapshot,
  ProviderSessionHandle,
  SessionBrowserPageRpc,
  SessionBrowserPathRpc,
  SessionRelation
} from "@another-workbench/shared";
import {
  SessionBrowserReadModel,
  type SessionBrowserReadModelSeed
} from "./session-browser-read-model.js";
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
  takeoverStatus?: "managed" | "agent";
  takeoverPresetId?: string;
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
  resolveTakeoverMarker?: (
    sessionId: string
  ) => { takeoverStatus?: "managed" | "agent"; takeoverPresetId?: string };
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
  metadata?: Record<string, unknown>;
};

const compareSeedLastCompletedTurnAtDesc = (
  left: SessionCatalogSeed,
  right: SessionCatalogSeed
): number => {
  const leftSortAt = left.lastCompletedTurnAt ?? left.updatedAt ?? left.createdAt;
  const rightSortAt = right.lastCompletedTurnAt ?? right.updatedAt ?? right.createdAt;
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
    runtimeStatus: session.status,
    metadata: session.metadata
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
  private readonly resolveTakeoverMarker:
    | SessionCatalogServiceOptions["resolveTakeoverMarker"]
    | undefined;
  private catalogRevision = 0;
  private materialized:
    | { sourceRevision: string; model: SessionBrowserReadModel }
    | undefined;
  private materializing:
    | { sourceRevision: string; promise: Promise<SessionBrowserReadModel> }
    | undefined;

  public constructor(options: SessionCatalogServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.resolveTakeoverMarker = options.resolveTakeoverMarker;
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
        unreadState: entry.unreadState,
        metadata: entry.metadata
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
        unreadState: existing?.unreadState,
        metadata: runtimeSeed.metadata ?? existing?.metadata
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

  public async listRoots(input: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): Promise<SessionBrowserPageRpc> {
    return (await this.getReadModel()).listRoots(input);
  }

  public async listChildren(input: {
    workspaceId: string;
    parentSessionId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): Promise<SessionBrowserPageRpc> {
    return (await this.getReadModel()).listChildren(input);
  }

  public async getPath(sessionId: string): Promise<SessionBrowserPathRpc> {
    return (await this.getReadModel()).getPath(sessionId);
  }

  public invalidate(): void {
    this.catalogRevision += 1;
    this.materialized = undefined;
  }

  public async markSessionRead(sessionId: string): Promise<void> {
    await this.sessionIndexStore.markSessionRead(sessionId);
  }

  private async getReadModel(): Promise<SessionBrowserReadModel> {
    await this.workspaceRegistry.ready();
    await this.sessionIndexStore.ready();
    while (true) {
      const sourceRevision = this.getSourceRevision();
      if (this.materialized?.sourceRevision === sourceRevision) {
        return this.materialized.model;
      }
      if (this.materializing?.sourceRevision === sourceRevision) {
        const model = await this.materializing.promise;
        if (this.getSourceRevision() === sourceRevision) {
          this.materialized = { sourceRevision, model };
          return model;
        }
        continue;
      }
      const promise = this.materializeReadModel();
      this.materializing = { sourceRevision, promise };
      let model: SessionBrowserReadModel;
      try {
        model = await promise;
      } finally {
        if (this.materializing?.promise === promise) {
          this.materializing = undefined;
        }
      }
      if (this.getSourceRevision() === sourceRevision) {
        this.materialized = { sourceRevision, model };
        return model;
      }
    }
  }

  private getSourceRevision(): string {
    return [
      this.runtimeService.getSessionBrowserRevision(),
      this.sessionIndexStore.getRevision(),
      this.workspaceRegistry.getSessionBrowserRevision(),
      this.catalogRevision
    ].join(":");
  }

  private async materializeReadModel(): Promise<SessionBrowserReadModel> {
    const snapshot = this.runtimeService.getSnapshot();
    const registryState = this.workspaceRegistry.getState();
    const runtimeSessionIds = new Set(snapshot.sessions.map((session) => session.sessionId));
    const lastCompletedTurnAtBySessionId = collectLastCompletedTurnAtBySessionId(snapshot.turns);
    const bySessionId = new Map<string, SessionCatalogSeed>();

    for (const entry of this.sessionIndexStore.listEntries()) {
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
        unreadState: entry.unreadState,
        metadata: entry.metadata
      });
    }
    for (const session of snapshot.sessions) {
      const runtimeSeed = toSeedFromRuntime(snapshot, session, lastCompletedTurnAtBySessionId);
      if (!runtimeSeed) {
        continue;
      }
      const existing = bySessionId.get(runtimeSeed.sessionId);
      bySessionId.set(runtimeSeed.sessionId, {
        ...existing,
        ...runtimeSeed,
        lastCompletedTurnAt: runtimeSeed.lastCompletedTurnAt ?? existing?.lastCompletedTurnAt,
        summaryText: existing?.summaryText,
        unreadState: existing?.unreadState,
        metadata: runtimeSeed.metadata ?? existing?.metadata
      });
    }

    const visible = new Map(
      [...bySessionId.values()]
        .filter((seed) => isBrowserVisibleSeed(seed, runtimeSessionIds))
        .map((seed) => [seed.sessionId, seed] as const)
    );
    const parentByChildId = new Map<string, string>();
    for (const relation of this.mergeRelations(snapshot.sessionRelations, this.sessionIndexStore.listRelations())) {
      const parent = visible.get(relation.parentSessionId);
      const child = visible.get(relation.childSessionId);
      if (
        parent &&
        child &&
        parent.workspaceId === child.workspaceId &&
        !parentByChildId.has(child.sessionId)
      ) {
        parentByChildId.set(child.sessionId, parent.sessionId);
      }
    }
    const childCountByParentId = new Map<string, number>();
    for (const parentSessionId of parentByChildId.values()) {
      childCountByParentId.set(
        parentSessionId,
        (childCountByParentId.get(parentSessionId) ?? 0) + 1
      );
    }

    const seeds: SessionBrowserReadModelSeed[] = [...visible.values()].map((seed) => {
      const marker =
        this.resolveTakeoverMarker?.(seed.sessionId) ??
        this.resolveMetadataTakeoverMarker(seed.metadata);
      return {
        sessionId: seed.sessionId,
        parentSessionId: parentByChildId.get(seed.sessionId),
        workspaceId: seed.workspaceId,
        engineId: seed.engineId,
        title: seed.title ?? seed.sessionId,
        statusDot:
          seed.runtimeStatus === "running" || seed.runtimeStatus === "awaiting_approval"
            ? "running"
            : registryState.lastActiveSessionId === seed.sessionId
              ? "none"
              : seed.unreadState === "unread_completed"
                ? "unread_completed"
                : "none",
        takeoverStatus: marker.takeoverStatus,
        takeoverPresetId: marker.takeoverPresetId,
        isActive: registryState.lastActiveSessionId === seed.sessionId,
        childCount: childCountByParentId.get(seed.sessionId) ?? 0,
        lastCompletedTurnAt: seed.lastCompletedTurnAt,
        sortAt: seed.lastCompletedTurnAt ?? seed.updatedAt ?? seed.createdAt
      };
    });
    return new SessionBrowserReadModel(seeds);
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

    const marker =
      this.resolveTakeoverMarker?.(input.seed.sessionId) ??
      this.resolveMetadataTakeoverMarker(input.seed.metadata);
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
      takeoverStatus: marker.takeoverStatus,
      takeoverPresetId: marker.takeoverPresetId,
      isExpanded: input.expandedSessionIds.includes(input.seed.sessionId),
      isActive: input.activeSessionId === input.seed.sessionId,
      isArchived: Boolean(input.seed.archivedAt),
      parentSessionId: input.parentSessionId,
      children,
      updatedAt: input.seed.updatedAt,
      lastCompletedTurnAt: input.seed.lastCompletedTurnAt
    };
  }

  private resolveMetadataTakeoverMarker(
    metadata: Record<string, unknown> | undefined
  ): { takeoverStatus?: "managed" | "agent"; takeoverPresetId?: string } {
    const takeover = metadata?.takeover;
    if (!takeover || typeof takeover !== "object" || Array.isArray(takeover)) {
      return {};
    }
    const record = takeover as Record<string, unknown>;
    if (record.role !== "takeover-agent") {
      return {};
    }
    return {
      takeoverStatus: "agent",
      takeoverPresetId:
        typeof record.presetId === "string" ? record.presetId : undefined
    };
  }
}
