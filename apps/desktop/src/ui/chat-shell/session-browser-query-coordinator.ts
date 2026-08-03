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
    }
  | {
      kind: "children";
      workspaceId: string;
      parentSessionId: string;
      cursor?: string;
      limit?: number;
    };

export type SessionBrowserQueryScope =
  | { kind: "roots"; workspaceId: string }
  | { kind: "children"; workspaceId: string; parentSessionId: string };

type SessionBrowserCollectionInput = { workspaceId: string; parentSessionId?: string };

export type SessionBrowserQueryResult =
  | {
      status: "committed";
      page: SessionBrowserPageRpc;
      recoveredRootPage?: SessionBrowserPageRpc;
    }
  | {
      status: "superseded";
      reason: "replaced" | "invalidated" | "revision_changed";
    }
  | { status: "cancelled" };

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

const isCursorStale = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "CURSOR_STALE";

type TerminalResult = Exclude<SessionBrowserQueryResult, { status: "committed" }>;

const invalidated: TerminalResult = { status: "superseded", reason: "invalidated" };
const revisionChanged: TerminalResult = { status: "superseded", reason: "revision_changed" };
const cancelled: TerminalResult = { status: "cancelled" };

const committed = (
  page: SessionBrowserPageRpc,
  recoveredRootPage?: SessionBrowserPageRpc
): SessionBrowserQueryResult =>
  recoveredRootPage
    ? { status: "committed", page, recoveredRootPage }
    : { status: "committed", page };

type ActiveRequest = {
  key: string;
  scope: SessionBrowserQueryScope;
  workspaceOwner: WorkspaceRevisionOwner;
  terminalResult?: TerminalResult;
  result: Promise<SessionBrowserQueryResult>;
};

type WorkspaceRevisionOwner = { revision?: string };

type RevisionRecovery = {
  owner?: WorkspaceRevisionOwner;
  page?: SessionBrowserPageRpc;
  rootPageClaimed?: boolean;
  result: Promise<SessionBrowserPageRpc | undefined>;
};

const rootPageSize = 10;

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
    Math.min(100, Math.max(1, query.limit ?? 20))
  ]);

export class SessionBrowserQueryCoordinator {
  private readonly activeByScope = new Map<string, ActiveRequest>();
  private readonly revisionOwnerByWorkspace = new Map<string, WorkspaceRevisionOwner>();
  private readonly pathRequests = new Map<string, Promise<SessionBrowserPathRpc>>();
  private readonly revisionRecoveryByWorkspace = new Map<string, RevisionRecovery>();

  public constructor(private readonly transport: SessionBrowserQueryTransport) {}

  public load(query: SessionBrowserPageQuery): Promise<SessionBrowserQueryResult> {
    const scope = queryScope(query);
    const collectionKey = scopeKey(scope);
    const key = queryKey(query);
    const workspaceOwner = this.workspaceOwner(query.workspaceId);
    const existing = this.activeByScope.get(collectionKey);
    if (existing?.key === key) {
      return existing.result;
    }
    if (existing) {
      this.terminate(existing, { status: "superseded", reason: "replaced" });
    }

    let active: ActiveRequest;
    const result = Promise.resolve()
      .then(() => this.execute(query, active))
      .finally(() => {
        if (this.activeByScope.get(collectionKey) === active) {
          this.activeByScope.delete(collectionKey);
        }
        this.discardRecoveryIfIdle(query.workspaceId);
      });
    active = { key, scope, workspaceOwner, result };
    this.activeByScope.set(collectionKey, active);
    return result;
  }

  public isLoading(scope: SessionBrowserQueryScope): boolean {
    return this.activeByScope.has(scopeKey(scope));
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

  public invalidateCollection(input: SessionBrowserCollectionInput): SessionBrowserQueryScope[] {
    return this.terminateCollection(input, invalidated);
  }

  public cancelCollection(
    input: SessionBrowserCollectionInput
  ): SessionBrowserQueryScope[] {
    return this.terminateCollection(input, cancelled);
  }

  public invalidateWorkspace(workspaceId: string): SessionBrowserQueryScope[] {
    this.revisionOwnerByWorkspace.delete(workspaceId);
    this.revisionRecoveryByWorkspace.delete(workspaceId);
    return this.terminateWorkspace(workspaceId, invalidated);
  }

  public cancelWorkspace(workspaceId: string): SessionBrowserQueryScope[] {
    this.revisionRecoveryByWorkspace.delete(workspaceId);
    return this.terminateWorkspace(workspaceId, cancelled);
  }

  public clearWorkspace(workspaceId: string): SessionBrowserQueryScope[] { return this.invalidateWorkspace(workspaceId); }

  private async execute(
    query: SessionBrowserPageQuery,
    active: ActiveRequest
  ): Promise<SessionBrowserQueryResult> {
    const requestedRevision = this.expectedRevision(query, active.workspaceOwner);
    try {
      const page = await this.requestPage(query, requestedRevision);
      const terminal = this.terminalResult(active);
      if (terminal) return terminal;
      const rootResult = this.rootResultAfterOwnerChange(active, revisionChanged);
      if (rootResult) return rootResult;
      if (!this.isCurrentWorkspaceOwner(active)) {
        return this.recoverRevision(query, active, requestedRevision);
      }
      if (this.acceptPage(query, active, page)) {
        return committed(page);
      }
    } catch (error) {
      const terminal = this.terminalResult(active);
      if (terminal) return terminal;
      const stale = isCursorStale(error);
      const rootResult = this.rootResultAfterOwnerChange(
        active,
        stale ? revisionChanged : undefined
      );
      if (rootResult) return rootResult;
      if (!stale) {
        throw error;
      }
    }
    return this.recoverRevision(query, active, requestedRevision);
  }

  private async recoverRevision(
    query: SessionBrowserPageQuery,
    active: ActiveRequest,
    requestedRevision: string | undefined
  ): Promise<SessionBrowserQueryResult> {
    try {
      const currentOwner = this.revisionOwnerByWorkspace.get(query.workspaceId);
      let recovery = this.revisionRecoveryByWorkspace.get(query.workspaceId);
      let rootPage: SessionBrowserPageRpc | undefined;
      if (
        query.kind === "children" &&
        requestedRevision &&
        currentOwner?.revision &&
        requestedRevision !== currentOwner.revision
      ) {
        active.workspaceOwner = currentOwner;
        rootPage = recovery?.owner === currentOwner ? recovery.page : undefined;
      } else {
        if (recovery?.owner === active.workspaceOwner) {
          this.revisionRecoveryByWorkspace.delete(query.workspaceId);
          recovery = undefined;
        }
        if (currentOwner === active.workspaceOwner) {
          this.revisionOwnerByWorkspace.delete(query.workspaceId);
        }
        recovery ??= this.recoverWorkspaceRevision(query.workspaceId);
        rootPage = await recovery.result;
      }
      const terminal = this.terminalResult(active);
      if (terminal) {
        return terminal;
      }
      const recoveredOwner =
        recovery?.owner ?? this.revisionOwnerByWorkspace.get(query.workspaceId);
      if (
        !recoveredOwner?.revision ||
        this.revisionOwnerByWorkspace.get(query.workspaceId) !== recoveredOwner
      ) {
        return revisionChanged;
      }
      active.workspaceOwner = recoveredOwner;
      if (query.kind === "roots") {
        const claimed = this.claimRecovery(query.workspaceId);
        if (!claimed?.page) {
          return revisionChanged;
        }
        return committed(claimed.page, claimed.page);
      }
      const page = await this.requestPage(
        { ...query, cursor: undefined },
        recoveredOwner.revision
      );
      const retryTerminal = this.terminalResult(active);
      if (retryTerminal) {
        return retryTerminal;
      }
      if (
        !this.isCurrentWorkspaceOwner(active) ||
        page.revision !== recoveredOwner.revision
      ) {
        return revisionChanged;
      }
      const claimed = rootPage ? this.claimRecovery(query.workspaceId) : undefined;
      return committed(page, claimed?.page);
    } catch (error) {
      const terminal = this.terminalResult(active);
      if (terminal) {
        return terminal;
      }
      if (isCursorStale(error)) {
        return revisionChanged;
      }
      throw error;
    }
  }

  private recoverWorkspaceRevision(workspaceId: string): RevisionRecovery {
    const existing = this.revisionRecoveryByWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }
    let recovery: RevisionRecovery;
    const result = this.transport
      .listRoots({
        workspaceId,
        cursor: undefined,
        expectedRevision: undefined,
        limit: rootPageSize
      })
      .then((page) => {
        if (this.revisionRecoveryByWorkspace.get(workspaceId) !== recovery) {
          return undefined;
        }
        const owner = { revision: page.revision };
        recovery.owner = owner;
        recovery.page = page;
        this.revisionOwnerByWorkspace.set(workspaceId, owner);
        return page;
      })
      .catch((error: unknown) => {
        if (this.revisionRecoveryByWorkspace.get(workspaceId) === recovery) {
          this.revisionRecoveryByWorkspace.delete(workspaceId);
        }
        throw error;
      });
    recovery = { result };
    this.revisionRecoveryByWorkspace.set(workspaceId, recovery);
    return recovery;
  }

  private expectedRevision(
    query: SessionBrowserPageQuery,
    owner = this.revisionOwnerByWorkspace.get(query.workspaceId)
  ): string | undefined {
    return query.cursor || query.kind === "children" ? owner?.revision : undefined;
  }

  private requestPage(
    query: SessionBrowserPageQuery,
    expectedRevision = this.expectedRevision(query)
  ): Promise<SessionBrowserPageRpc> {
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
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
    active: ActiveRequest,
    page: SessionBrowserPageRpc
  ): boolean {
    const acceptedRevision = active.workspaceOwner.revision;
    if (
      acceptedRevision &&
      page.revision !== acceptedRevision &&
      (query.cursor || query.kind === "children")
    ) {
      return false;
    }
    if (
      !acceptedRevision ||
      (!query.cursor &&
        query.kind === "roots" &&
        page.revision !== acceptedRevision)
    ) {
      const owner = { revision: page.revision };
      active.workspaceOwner = owner;
      this.revisionOwnerByWorkspace.set(query.workspaceId, owner);
      if (
        query.kind === "roots" &&
        !query.cursor &&
        this.revisionRecoveryByWorkspace.get(query.workspaceId)?.page?.revision !==
          page.revision
      ) {
        this.revisionRecoveryByWorkspace.delete(query.workspaceId);
      }
    }
    return true;
  }

  private terminalResult(active: ActiveRequest): TerminalResult | undefined {
    return active.terminalResult ??
      (this.activeByScope.get(scopeKey(active.scope)) === active
        ? undefined
        : invalidated);
  }

  private workspaceOwner(workspaceId: string): WorkspaceRevisionOwner {
    const existing = this.revisionOwnerByWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }
    const owner: WorkspaceRevisionOwner = {};
    this.revisionOwnerByWorkspace.set(workspaceId, owner);
    return owner;
  }

  private isCurrentWorkspaceOwner(active: ActiveRequest): boolean {
    return (
      this.revisionOwnerByWorkspace.get(active.scope.workspaceId) ===
      active.workspaceOwner
    );
  }

  private rootResultAfterOwnerChange(
    active: ActiveRequest,
    fallback?: TerminalResult
  ): SessionBrowserQueryResult | undefined {
    if (active.scope.kind !== "roots" || this.isCurrentWorkspaceOwner(active)) return undefined;
    const recovery = this.claimRecovery(active.scope.workspaceId);
    if (!recovery?.owner || !recovery.page) return fallback;
    active.workspaceOwner = recovery.owner;
    return committed(recovery.page, recovery.page);
  }

  private claimRecovery(workspaceId: string): RevisionRecovery | undefined {
    const recovery = this.revisionRecoveryByWorkspace.get(workspaceId);
    if (
      !recovery?.owner ||
      !recovery.page ||
      recovery.rootPageClaimed ||
      this.revisionOwnerByWorkspace.get(workspaceId) !== recovery.owner
    ) {
      return undefined;
    }
    recovery.rootPageClaimed = true;
    return recovery;
  }

  private terminateScope(
    scope: SessionBrowserQueryScope,
    result: TerminalResult
  ): SessionBrowserQueryScope[] {
    const active = this.activeByScope.get(scopeKey(scope));
    if (active) {
      this.terminate(active, result);
      return [scope];
    }
    return [];
  }

  private terminateCollection(
    input: SessionBrowserCollectionInput,
    result: TerminalResult
  ): SessionBrowserQueryScope[] {
    const scope: SessionBrowserQueryScope = input.parentSessionId
      ? { kind: "children", ...input, parentSessionId: input.parentSessionId }
      : { kind: "roots", workspaceId: input.workspaceId };
    const affected = this.terminateScope(scope, result);
    this.discardRecoveryIfIdle(input.workspaceId);
    return affected;
  }

  private terminateWorkspace(workspaceId: string, result: TerminalResult): SessionBrowserQueryScope[] {
    const affected: SessionBrowserQueryScope[] = [];
    for (const active of this.activeByScope.values()) {
      if (active.scope.workspaceId === workspaceId) {
        affected.push(active.scope);
        this.terminate(active, result);
      }
    }
    return affected;
  }

  private discardRecoveryIfIdle(workspaceId: string): void {
    for (const active of this.activeByScope.values()) {
      if (active.scope.workspaceId === workspaceId) {
        return;
      }
    }
    this.revisionRecoveryByWorkspace.delete(workspaceId);
  }

  private terminate(active: ActiveRequest, result: TerminalResult): void {
    active.terminalResult = result;
    const key = scopeKey(active.scope);
    if (this.activeByScope.get(key) === active) {
      this.activeByScope.delete(key);
    }
  }
}
