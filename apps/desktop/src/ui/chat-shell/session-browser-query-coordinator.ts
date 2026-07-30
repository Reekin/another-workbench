import type {
  SessionBrowserPageRpc,
  SessionBrowserPathRpc
} from "@another-workbench/shared";

export type SessionBrowserPageQuery =
  | {
      kind: "roots";
      workspaceId: string;
      cursor?: string;
      limit?: number;
      expectedRevision?: string;
    }
  | {
      kind: "children";
      workspaceId: string;
      parentSessionId: string;
      cursor?: string;
      limit?: number;
      expectedRevision?: string;
    };

export type SessionBrowserQueryScope =
  | {
      kind: "roots";
      workspaceId: string;
    }
  | {
      kind: "children";
      workspaceId: string;
      parentSessionId: string;
    };

export type SessionBrowserQueryOwner = {
  scope: SessionBrowserQueryScope;
  generation: number;
};

export type SessionBrowserQueryResult =
  | ({ status: "committed"; page: SessionBrowserPageRpc } & SessionBrowserQueryOwner)
  | ({
      status: "superseded";
      reason: "replaced" | "invalidated" | "revision_changed";
    } & SessionBrowserQueryOwner)
  | ({ status: "cancelled" } & SessionBrowserQueryOwner);

export type SessionBrowserQueryRequest = SessionBrowserQueryOwner & {
  result: Promise<SessionBrowserQueryResult>;
};

export type SessionBrowserQueryTransport = {
  listRoots: (input: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }) => Promise<SessionBrowserPageRpc>;
  listChildren: (input: {
    workspaceId: string;
    parentSessionId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }) => Promise<SessionBrowserPageRpc>;
  getPath: (sessionId: string) => Promise<SessionBrowserPathRpc>;
};

export const isSessionBrowserCursorStaleError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "CURSOR_STALE";

type QueryState = {
  data?: SessionBrowserPageRpc;
  dirty: boolean;
};

type ActiveRequest = SessionBrowserQueryOwner & {
  key: string;
  terminalResult?:
    | { status: "superseded"; reason: "replaced" | "invalidated" }
    | { status: "cancelled" };
  request: SessionBrowserQueryRequest;
};

const queryScope = (query: SessionBrowserPageQuery): SessionBrowserQueryScope =>
  query.kind === "roots"
    ? { kind: "roots", workspaceId: query.workspaceId }
    : {
        kind: "children",
        workspaceId: query.workspaceId,
        parentSessionId: query.parentSessionId
      };

const scopeKey = (scope: SessionBrowserQueryScope): string =>
  JSON.stringify([
    scope.kind,
    scope.workspaceId,
    scope.kind === "children" ? scope.parentSessionId : null
  ]);

const queryKey = (query: SessionBrowserPageQuery): string =>
  JSON.stringify([
    query.kind,
    query.workspaceId,
    query.kind === "children" ? query.parentSessionId : null,
    query.cursor ?? null,
    query.expectedRevision ?? null,
    Math.min(100, Math.max(1, query.limit ?? 20))
  ]);

export class SessionBrowserQueryCoordinator {
  private readonly states = new Map<string, QueryState>();
  private readonly acceptedRevisionByWorkspace = new Map<string, string>();
  private readonly generationByScope = new Map<string, number>();
  private readonly activeByScope = new Map<string, ActiveRequest>();
  private readonly scopeByKey = new Map<string, SessionBrowserQueryScope>();
  private readonly pathRequests = new Map<string, Promise<SessionBrowserPathRpc>>();

  public constructor(private readonly transport: SessionBrowserQueryTransport) {}

  public load(query: SessionBrowserPageQuery): SessionBrowserQueryRequest {
    const key = queryKey(query);
    const scope = queryScope(query);
    const collectionKey = scopeKey(scope);
    this.scopeByKey.set(collectionKey, scope);
    const existing = this.activeByScope.get(collectionKey);
    if (existing?.key === key) {
      return existing.request;
    }
    if (existing) {
      existing.terminalResult = {
        status: "superseded",
        reason: "replaced"
      };
      this.activeByScope.delete(collectionKey);
    }

    const state = this.states.get(key) ?? { dirty: true };
    this.states.set(key, state);
    const generation = this.nextGeneration(collectionKey);
    if (!state.dirty && state.data) {
      let active!: ActiveRequest;
      const result = Promise.resolve()
        .then((): SessionBrowserQueryResult => {
          if (active.terminalResult) {
            return { ...active.terminalResult, scope, generation };
          }
          if (this.generationByScope.get(collectionKey) !== generation) {
            return {
              status: "superseded",
              reason: "invalidated",
              scope,
              generation
            };
          }
          return {
            status: "committed",
            scope,
            generation,
            page: state.data!
          };
        })
        .finally(() => {
          if (this.activeByScope.get(collectionKey) === active) {
            this.activeByScope.delete(collectionKey);
          }
        });
      const request: SessionBrowserQueryRequest = { scope, generation, result };
      active = { scope, generation, key, request };
      this.activeByScope.set(collectionKey, active);
      return request;
    }

    state.dirty = false;
    let active!: ActiveRequest;
    const result = this.requestPage(query)
      .then((page): SessionBrowserQueryResult => {
        if (active.terminalResult) {
          return { ...active.terminalResult, scope, generation };
        }
        if (this.generationByScope.get(collectionKey) !== generation) {
          return {
            status: "superseded",
            reason: "invalidated",
            scope,
            generation
          };
        }
        if (!this.acceptPage(query, state, page)) {
          state.dirty = true;
          return {
            status: "superseded",
            reason: "revision_changed",
            scope,
            generation
          };
        }
        return { status: "committed", scope, generation, page };
      })
      .catch((error: unknown): SessionBrowserQueryResult => {
        if (active.terminalResult) {
          return { ...active.terminalResult, scope, generation };
        }
        state.dirty = true;
        throw error;
      })
      .finally(() => {
        if (this.activeByScope.get(collectionKey) === active) {
          this.activeByScope.delete(collectionKey);
        }
      });
    const request: SessionBrowserQueryRequest = { scope, generation, result };
    active = { scope, generation, key, request };
    this.activeByScope.set(collectionKey, active);
    return request;
  }

  public getPath(sessionId: string): Promise<SessionBrowserPathRpc> {
    const existing = this.pathRequests.get(sessionId);
    if (existing) {
      return existing;
    }
    const request = this.transport.getPath(sessionId).finally(() => {
      if (this.pathRequests.get(sessionId) === request) {
        this.pathRequests.delete(sessionId);
      }
    });
    this.pathRequests.set(sessionId, request);
    return request;
  }

  public invalidateCollection(input: {
    workspaceId: string;
    parentSessionId?: string;
  }): SessionBrowserQueryOwner[] {
    const scope: SessionBrowserQueryScope = input.parentSessionId
      ? {
          kind: "children",
          workspaceId: input.workspaceId,
          parentSessionId: input.parentSessionId
        }
      : { kind: "roots", workspaceId: input.workspaceId };
    this.markScopeDirty(scope);
    const owner = this.terminateScope(scope, {
      status: "superseded",
      reason: "invalidated"
    });
    return owner ? [owner] : [];
  }

  public cancelCollection(input: {
    workspaceId: string;
    parentSessionId?: string;
  }): SessionBrowserQueryOwner[] {
    const scope: SessionBrowserQueryScope = input.parentSessionId
      ? {
          kind: "children",
          workspaceId: input.workspaceId,
          parentSessionId: input.parentSessionId
        }
      : { kind: "roots", workspaceId: input.workspaceId };
    this.markScopeDirty(scope);
    const owner = this.terminateScope(scope, { status: "cancelled" });
    return owner ? [owner] : [];
  }

  public invalidateWorkspace(workspaceId: string): SessionBrowserQueryOwner[] {
    this.acceptedRevisionByWorkspace.delete(workspaceId);
    const scopes = this.workspaceScopes(workspaceId);
    const owners: SessionBrowserQueryOwner[] = [];
    for (const scope of scopes) {
      this.markScopeDirty(scope);
      const owner = this.terminateScope(scope, {
        status: "superseded",
        reason: "invalidated"
      });
      if (owner) {
        owners.push(owner);
      }
    }
    return owners;
  }

  public getCached(query: SessionBrowserPageQuery): SessionBrowserPageRpc | undefined {
    return this.states.get(queryKey(query))?.data;
  }

  public clearWorkspace(workspaceId: string): SessionBrowserQueryOwner[] {
    const owners = this.invalidateWorkspace(workspaceId);
    for (const key of this.states.keys()) {
      const parsed = JSON.parse(key) as [string, string];
      if (parsed[1] === workspaceId) {
        this.states.delete(key);
      }
    }
    return owners;
  }

  private requestPage(query: SessionBrowserPageQuery): Promise<SessionBrowserPageRpc> {
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const expectedRevision =
      query.expectedRevision ??
      (query.cursor || query.kind === "children"
        ? this.acceptedRevisionByWorkspace.get(query.workspaceId)
        : undefined);
    return query.kind === "roots"
      ? this.transport.listRoots({
          workspaceId: query.workspaceId,
          cursor: query.cursor,
          expectedRevision,
          limit
        })
      : this.transport.listChildren({
          workspaceId: query.workspaceId,
          parentSessionId: query.parentSessionId,
          cursor: query.cursor,
          expectedRevision,
          limit
        });
  }

  private acceptPage(
    query: SessionBrowserPageQuery,
    state: QueryState,
    page: SessionBrowserPageRpc
  ): boolean {
    const acceptedRevision = this.acceptedRevisionByWorkspace.get(query.workspaceId);
    if (acceptedRevision && page.revision !== acceptedRevision) {
      if (query.cursor || query.kind === "children") {
        return false;
      }
    }
    if (!query.cursor && acceptedRevision !== page.revision) {
      this.acceptedRevisionByWorkspace.set(query.workspaceId, page.revision);
      for (const [key, otherState] of this.states) {
        if (key === queryKey(query)) {
          continue;
        }
        const parsed = JSON.parse(key) as [string, string];
        if (
          parsed[1] === query.workspaceId &&
          otherState.data?.revision !== page.revision
        ) {
          otherState.dirty = true;
          otherState.data = undefined;
        }
      }
    }
    state.data = page;
    return true;
  }

  private markScopeDirty(scope: SessionBrowserQueryScope): void {
    for (const [key, state] of this.states) {
      const parsed = JSON.parse(key) as [string, string, string | null];
      if (
        parsed[1] === scope.workspaceId &&
        parsed[2] === (scope.kind === "children" ? scope.parentSessionId : null)
      ) {
        state.dirty = true;
      }
    }
  }

  private terminateScope(
    scope: SessionBrowserQueryScope,
    result:
      | { status: "superseded"; reason: "invalidated" }
      | { status: "cancelled" }
  ): SessionBrowserQueryOwner | undefined {
    const key = scopeKey(scope);
    const active = this.activeByScope.get(key);
    const generation = active?.generation ?? this.generationByScope.get(key);
    if (active) {
      active.terminalResult = result;
      this.activeByScope.delete(key);
    }
    this.nextGeneration(key);
    return generation === undefined ? undefined : { scope, generation };
  }

  private workspaceScopes(workspaceId: string): SessionBrowserQueryScope[] {
    const scopes = new Map<string, SessionBrowserQueryScope>();
    for (const [key, scope] of this.scopeByKey) {
      if (scope.workspaceId === workspaceId) {
        scopes.set(key, scope);
      }
    }
    for (const active of this.activeByScope.values()) {
      if (active.scope.workspaceId === workspaceId) {
        scopes.set(scopeKey(active.scope), active.scope);
      }
    }
    return [...scopes.values()];
  }

  private nextGeneration(key: string): number {
    const generation = (this.generationByScope.get(key) ?? 0) + 1;
    this.generationByScope.set(key, generation);
    return generation;
  }
}
