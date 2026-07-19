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
  generation: number;
  inFlight?: Promise<SessionBrowserPageRpc>;
};

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
  private readonly workspaceGeneration = new Map<string, number>();
  private readonly pathRequests = new Map<string, Promise<SessionBrowserPathRpc>>();

  public constructor(private readonly transport: SessionBrowserQueryTransport) {}

  public load(query: SessionBrowserPageQuery): Promise<SessionBrowserPageRpc> {
    const key = queryKey(query);
    const state = this.states.get(key) ?? { dirty: true, generation: 0 };
    this.states.set(key, state);
    if (state.inFlight) {
      return state.inFlight;
    }
    if (!state.dirty && state.data) {
      return Promise.resolve(state.data);
    }

    state.dirty = false;
    const requestGeneration = ++state.generation;
    const workspaceGeneration = this.workspaceGeneration.get(query.workspaceId) ?? 0;
    const request = this.requestPage(query).then((page) => {
      const latestWorkspaceGeneration = this.workspaceGeneration.get(query.workspaceId) ?? 0;
      if (
        state.generation === requestGeneration &&
        workspaceGeneration === latestWorkspaceGeneration
      ) {
        this.acceptPage(query, state, page);
      }
      return page;
    }).finally(() => {
      if (state.inFlight === request) {
        state.inFlight = undefined;
      }
      if (state.dirty) {
        void this.load(query);
      }
    });
    state.inFlight = request;
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
  }): void {
    this.bumpWorkspaceGeneration(input.workspaceId);
    for (const [key, state] of this.states) {
      const parsed = JSON.parse(key) as [string, string, string | null];
      if (
        parsed[1] === input.workspaceId &&
        parsed[2] === (input.parentSessionId ?? null)
      ) {
        state.dirty = true;
      }
    }
  }

  public invalidateWorkspace(workspaceId: string): void {
    this.bumpWorkspaceGeneration(workspaceId);
    this.acceptedRevisionByWorkspace.delete(workspaceId);
    for (const [key, state] of this.states) {
      const parsed = JSON.parse(key) as [string, string];
      if (parsed[1] === workspaceId) {
        state.dirty = true;
      }
    }
  }

  public getCached(query: SessionBrowserPageQuery): SessionBrowserPageRpc | undefined {
    return this.states.get(queryKey(query))?.data;
  }

  public clearWorkspace(workspaceId: string): void {
    this.acceptedRevisionByWorkspace.delete(workspaceId);
    this.workspaceGeneration.delete(workspaceId);
    for (const key of this.states.keys()) {
      const parsed = JSON.parse(key) as [string, string];
      if (parsed[1] === workspaceId) {
        this.states.delete(key);
      }
    }
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
  ): void {
    const acceptedRevision = this.acceptedRevisionByWorkspace.get(query.workspaceId);
    if (query.cursor && acceptedRevision && page.revision !== acceptedRevision) {
      state.dirty = true;
      return;
    }
    if (!query.cursor && acceptedRevision !== page.revision) {
      this.acceptedRevisionByWorkspace.set(query.workspaceId, page.revision);
      for (const otherState of this.states.values()) {
        if (otherState.data?.workspaceId === query.workspaceId && otherState.data.revision !== page.revision) {
          otherState.dirty = true;
          otherState.data = undefined;
        }
      }
    }
    state.data = page;
  }

  private bumpWorkspaceGeneration(workspaceId: string): void {
    this.workspaceGeneration.set(
      workspaceId,
      (this.workspaceGeneration.get(workspaceId) ?? 0) + 1
    );
  }
}
