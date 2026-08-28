import { useEffect, useRef, useState } from "react";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  SessionBrowserQueryCoordinator,
  type SessionBrowserQueryScope
} from "./session-browser-query-coordinator.js";
import {
  applyChildrenPage,
  applyRootPage,
  collectAttentionSessions,
  mergeSessionPath,
  mergeWorkspaceBrowserState,
  resetRootPagination,
  setRootLoading,
  setSessionChildrenLoading,
  upsertWorkspaceBrowserRecord,
  updateSessionNode,
  type AttentionSessionViewNode,
  type SessionBrowserViewNode,
  type WorkspaceBrowserViewNode
} from "./workspace-browser-tree.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export const runAddWorkspaceFlow = async (input: {
  transport: DesktopTransport;
  onWorkspaceCommitted: (workspace: Awaited<ReturnType<DesktopTransport["workspace"]["add"]>>) => void;
  loadWorkspaceCatalog: (workspaceId: string) => Promise<void>;
  onStatusNotice: StatusNoticeSetter;
}): Promise<void> => {
  let rootPath: string;
  let workspace: Awaited<ReturnType<DesktopTransport["workspace"]["add"]>>;
  try {
    const picked = await input.transport.workspace.pickDirectory();
    if (picked.canceled || !picked.rootPath) {
      return;
    }
    rootPath = picked.rootPath;
    workspace = await input.transport.workspace.add({ rootPath });
  } catch (error) {
    input.onStatusNotice({
      message: `Add workspace failed: ${(error as Error).message}`,
      persistent: true,
      source: "workspace-add",
      ...statusNoticeErrorDetails(error)
    });
    return;
  }

  input.onWorkspaceCommitted(workspace);
  input.onStatusNotice({
    message: `Added workspace ${rootPath}`,
    source: "workspace-add"
  });

  try {
    await input.loadWorkspaceCatalog(workspace.workspaceId);
  } catch (error) {
    input.onStatusNotice({
      message: `Workspace added, but session browser load failed: ${(error as Error).message}`,
      persistent: true,
      source: "session-browser",
      ...statusNoticeErrorDetails(error)
    });
  }
};

const rootPageSize = 10;
const childPageSize = 20;

export const runSessionExpansionEffects = async (input: {
  persistExpansion: () => Promise<unknown>;
  loadChildren?: () => Promise<void>;
  onPersistenceError: (error: unknown) => void;
}): Promise<void> => {
  try {
    void input.persistExpansion().catch(input.onPersistenceError);
  } catch (error) {
    input.onPersistenceError(error);
  }
  await input.loadChildren?.();
};

export const shouldMergeFocusedSessionPath = (input: {
  loadedWorkspaceId: string;
  pathWorkspaceId: string;
}): boolean => input.loadedWorkspaceId === input.pathWorkspaceId;

export const runWorkspaceExpansionEffects = async (input: {
  expanded: boolean;
  cancelLoads?: () => void;
  persistExpansion: () => Promise<unknown>;
  selectWorkspace: () => Promise<unknown>;
  loadRoots: () => Promise<void>;
}): Promise<void> => {
  if (!input.expanded) {
    input.cancelLoads?.();
  }
  await input.persistExpansion();
  if (!input.expanded) {
    return;
  }
  await input.selectWorkspace();
  await input.loadRoots();
};

const findSessionNode = (
  sessions: WorkspaceBrowserViewNode["sessions"],
  sessionId: string
): WorkspaceBrowserViewNode["sessions"][number] | undefined => {
  for (const session of sessions) {
    if (session.sessionId === sessionId) {
      return session;
    }
    const child = findSessionNode(session.children, sessionId);
    if (child) {
      return child;
    }
  }
  return undefined;
};

export const collectExpandedLoadedSessionIds = (
  sessions: WorkspaceBrowserViewNode["sessions"]
): string[] => {
  const sessionIds: string[] = [];
  for (const session of sessions) {
    if (!session.isExpanded) {
      continue;
    }
    if (session.hasLoadedChildren) {
      sessionIds.push(session.sessionId);
    }
    sessionIds.push(...collectExpandedLoadedSessionIds(session.children));
  }
  return sessionIds;
};

export const loadPersistedExpandedChildren = async (input: {
  sessions: SessionBrowserViewNode[];
  loadChildren: (sessionId: string) => Promise<void>;
}): Promise<void> => {
  await Promise.all(
    input.sessions
      .filter(
        (session) =>
          session.isExpanded &&
          session.childCount > 0 &&
          !session.hasLoadedChildren
      )
      .map((session) => input.loadChildren(session.sessionId))
  );
};

export const toggleSessionTreeNode = (
  workspace: WorkspaceBrowserViewNode,
  sessionId: string
): {
  workspace: WorkspaceBrowserViewNode;
  expanded: boolean;
  shouldLoad: boolean;
} => {
  let expanded = false;
  let shouldLoad = false;
  const nextWorkspace = updateSessionNode(workspace, sessionId, (session) => {
    expanded = !session.isExpanded;
    shouldLoad = expanded && !session.hasLoadedChildren;
    return { ...session, isExpanded: expanded };
  });
  return { workspace: nextWorkspace, expanded, shouldLoad };
};

export const resolveWorkspaceRefreshTargetIds = (input: {
  mode: "all" | "visible" | "workspace";
  workspaceId?: string;
  lastActiveWorkspaceId?: string;
  workspaces: Array<{ workspaceId: string; isExpanded: boolean }>;
}): string[] => {
  if (input.mode === "workspace") {
    return input.workspaceId ? [input.workspaceId] : [];
  }
  if (input.mode === "all") {
    return input.workspaces.map((workspace) => workspace.workspaceId);
  }
  const expandedWorkspaceIds = input.workspaces
    .filter((workspace) => workspace.isExpanded)
    .map((workspace) => workspace.workspaceId);
  if (expandedWorkspaceIds.length > 0) {
    return expandedWorkspaceIds;
  }
  return input.lastActiveWorkspaceId ? [input.lastActiveWorkspaceId] : [];
};

export const resolveStartupWorkspaceIds = (input: {
  expandedWorkspaceIds?: string[];
  lastActiveWorkspaceId?: string;
}): string[] =>
  input.expandedWorkspaceIds && input.expandedWorkspaceIds.length > 0
    ? input.expandedWorkspaceIds
    : input.lastActiveWorkspaceId
      ? [input.lastActiveWorkspaceId]
      : [];

export const loadWorkspaceCatalogs = async (input: {
  workspaceIds: string[];
  loadCatalog: (workspaceId: string) => Promise<void>;
}): Promise<void> => {
  await Promise.all(
    input.workspaceIds.map((workspaceId) => input.loadCatalog(workspaceId))
  );
};

export const projectSessionBrowserLoading = (
  workspace: WorkspaceBrowserViewNode,
  currentCoordinator: SessionBrowserQueryCoordinator | undefined,
  requestCoordinator: SessionBrowserQueryCoordinator,
  scope: SessionBrowserQueryScope
): WorkspaceBrowserViewNode => {
  if (currentCoordinator !== requestCoordinator) {
    return workspace;
  }
  const isLoading = requestCoordinator.isLoading(scope);
  return scope.kind === "roots"
    ? setRootLoading(workspace, isLoading)
    : setSessionChildrenLoading(workspace, scope.parentSessionId, isLoading);
};

export type WorkspaceBrowserController = {
  workspaceTree: WorkspaceBrowserViewNode[];
  attentionSessions: AttentionSessionViewNode[];
  refreshSessionBrowser: (input?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }) => Promise<void>;
  ensureSessionVisible: (sessionId: string) => Promise<string | undefined>;
  onAddWorkspace: () => Promise<void>;
  onToggleWorkspace: (workspaceId: string) => Promise<void>;
  onToggleSessionTree: (sessionId: string, workspaceId?: string) => Promise<void>;
  onLoadMoreSessionChildren: (sessionId: string, workspaceId: string) => Promise<void>;
  onPreviousWorkspacePage: (workspaceId: string) => Promise<void>;
  onNextWorkspacePage: (workspaceId: string) => Promise<void>;
};

export const useWorkspaceBrowserController = (input: {
  transport?: DesktopTransport;
  refreshSignal: number;
  focusSessionId?: string;
  onStatusNotice: StatusNoticeSetter;
}): WorkspaceBrowserController => {
  const [workspaceTree, setWorkspaceTreeState] = useState<WorkspaceBrowserViewNode[]>([]);
  const [attentionSessions, setAttentionSessions] = useState<AttentionSessionViewNode[]>([]);
  const workspaceTreeRef = useRef<WorkspaceBrowserViewNode[]>([]);
  const coordinatorRef = useRef<SessionBrowserQueryCoordinator | undefined>(undefined);
  const mountedRef = useRef(true);
  const workspaceListGenerationRef = useRef(0);
  const refreshSignalRef = useRef(input.refreshSignal);

  const setWorkspaceTree = (
    update: (current: WorkspaceBrowserViewNode[]) => WorkspaceBrowserViewNode[]
  ): void => {
    const next = update(workspaceTreeRef.current);
    workspaceTreeRef.current = next;
    setWorkspaceTreeState(next);
  };

  const updateWorkspace = (
    workspaceId: string,
    update: (workspace: WorkspaceBrowserViewNode) => WorkspaceBrowserViewNode
  ): void => {
    setWorkspaceTree((current) =>
      current.map((workspace) =>
        workspace.workspaceId === workspaceId ? update(workspace) : workspace
      )
    );
  };

  const clearCollectionLoading = (
    scopes: SessionBrowserQueryScope[]
  ): void => {
    for (const scope of scopes) {
      updateWorkspace(scope.workspaceId, (workspace) =>
        scope.kind === "roots"
          ? setRootLoading(workspace, false)
          : setSessionChildrenLoading(workspace, scope.parentSessionId, false)
      );
    }
  };

  const projectCollectionLoading = (
    coordinator: SessionBrowserQueryCoordinator,
    scope: SessionBrowserQueryScope
  ): void => {
    updateWorkspace(scope.workspaceId, (workspace) =>
      projectSessionBrowserLoading(
        workspace,
        coordinatorRef.current,
        coordinator,
        scope
      )
    );
  };

  const loadRootPage = async (
    workspaceId: string,
    pageIndex?: number,
    cursorHistoryOverride?: Array<string | undefined>
  ): Promise<void> => {
    const coordinator = coordinatorRef.current;
    const workspace = workspaceTreeRef.current.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!coordinator || !workspace?.isExpanded) {
      return;
    }
    const targetPageIndex = pageIndex ?? workspace.rootPageIndex;
    const cursorHistory =
      cursorHistoryOverride ??
      (workspace.rootCursorHistory.length > 0
        ? workspace.rootCursorHistory
        : [undefined]);
    const scope = { kind: "roots" as const, workspaceId };
    const resultPromise = coordinator.load({
      ...scope,
      cursor: cursorHistory[targetPageIndex],
      limit: rootPageSize
    });
    projectCollectionLoading(coordinator, scope);
    try {
      const result = await resultPromise;
      if (
        result.status !== "committed" ||
        !mountedRef.current ||
        coordinatorRef.current !== coordinator
      ) {
        return;
      }
      const recovered = Boolean(result.recoveredRootPage);
      let committed = false;
      let committedSessions: SessionBrowserViewNode[] = [];
      updateWorkspace(workspaceId, (current) => {
        if (!current.isExpanded) {
          return current;
        }
        committed = true;
        const next = applyRootPage(
          current,
          result.page,
          recovered ? 0 : targetPageIndex,
          recovered ? [undefined] : cursorHistory
        );
        committedSessions = next.sessions;
        return next;
      });
      await loadPersistedExpandedChildren({
        sessions: committedSessions,
        loadChildren: (sessionId) => loadChildren(workspaceId, sessionId, false)
      });
      if (committed && input.focusSessionId) {
        const path = await coordinator.getPath(input.focusSessionId).catch(
          () => undefined
        );
        if (
          path &&
          mountedRef.current &&
          coordinatorRef.current === coordinator &&
          shouldMergeFocusedSessionPath({
            loadedWorkspaceId: workspaceId,
            pathWorkspaceId: path.workspaceId
          })
        ) {
          updateWorkspace(path.workspaceId, (current) =>
            mergeSessionPath(current, path)
          );
        }
      }
    } finally {
      if (mountedRef.current) {
        projectCollectionLoading(coordinator, scope);
      }
    }
  };

  const ensureSessionVisible = async (
    sessionId: string
  ): Promise<string | undefined> => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) {
      return undefined;
    }
    const path = await coordinator.getPath(sessionId);
    if (!mountedRef.current) {
      return path.workspaceId;
    }
    updateWorkspace(path.workspaceId, (workspace) => mergeSessionPath(workspace, path));
    return path.workspaceId;
  };

  const refreshSessionBrowser = async (refreshInput?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }): Promise<void> => {
    if (!input.transport || !coordinatorRef.current) {
      workspaceListGenerationRef.current += 1;
      workspaceTreeRef.current = [];
      setWorkspaceTreeState([]);
      setAttentionSessions([]);
      return;
    }
    const requestGeneration = ++workspaceListGenerationRef.current;
    const [workspaceState, sessionTree] = await Promise.all([
      input.transport.workspace.list(),
      input.transport.sessionBrowser.listTree()
    ]);
    if (!mountedRef.current || requestGeneration !== workspaceListGenerationRef.current) {
      return;
    }
    setAttentionSessions(collectAttentionSessions(sessionTree.workspaces));
    const current = mergeWorkspaceBrowserState(workspaceTreeRef.current, workspaceState);
    workspaceTreeRef.current = current;
    setWorkspaceTreeState(current);
    const mode = refreshInput?.mode ?? "visible";
    const targetWorkspaceIds = resolveWorkspaceRefreshTargetIds({
      mode,
      workspaceId: refreshInput?.workspaceId,
      lastActiveWorkspaceId: workspaceState.lastActiveWorkspaceId,
      workspaces: current
    });
    const expandedCollectionsByWorkspace = new Map(
      current.map((workspace) => [
        workspace.workspaceId,
        collectExpandedLoadedSessionIds(workspace.sessions)
      ])
    );

    if (mode === "all" || mode === "visible") {
      for (const workspace of current) {
        clearCollectionLoading(
          coordinatorRef.current.invalidateWorkspace(workspace.workspaceId)
        );
      }
      setWorkspaceTree((workspaces) =>
        workspaces.map(resetRootPagination)
      );
    } else if (targetWorkspaceIds[0]) {
      clearCollectionLoading(
        coordinatorRef.current.invalidateWorkspace(targetWorkspaceIds[0])
      );
      updateWorkspace(targetWorkspaceIds[0], resetRootPagination);
    }

    await Promise.all(
      targetWorkspaceIds.map(async (workspaceId) => {
        await loadRootPage(workspaceId);
        await Promise.all(
          (expandedCollectionsByWorkspace.get(workspaceId) ?? []).map((sessionId) =>
            loadChildren(workspaceId, sessionId, false)
          )
        );
      })
    );
  };

  const loadChildren = async (
    workspaceId: string,
    sessionId: string,
    append: boolean
  ): Promise<void> => {
    const coordinator = coordinatorRef.current;
    const workspace = workspaceTreeRef.current.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    const session = workspace
      ? findSessionNode(workspace.sessions, sessionId)
      : undefined;
    if (!coordinator || !workspace || !session?.isExpanded) {
      return;
    }
    const scope = {
      kind: "children" as const,
      workspaceId,
      parentSessionId: sessionId
    };
    const resultPromise = coordinator.load({
      ...scope,
      cursor: append ? session.childrenNextCursor : undefined,
      limit: childPageSize
    });
    projectCollectionLoading(coordinator, scope);
    try {
      const result = await resultPromise;
      if (
        result.status !== "committed" ||
        !mountedRef.current ||
        coordinatorRef.current !== coordinator
      ) {
        return;
      }
      let committedChildren: SessionBrowserViewNode[] = [];
      updateWorkspace(workspaceId, (current) => {
        const withRecoveredRoots = result.recoveredRootPage
          ? setRootLoading(
              applyRootPage(current, result.recoveredRootPage, 0, [undefined]),
              coordinator.isLoading({ kind: "roots", workspaceId })
            )
          : current;
        const currentSession = findSessionNode(withRecoveredRoots.sessions, sessionId);
        if (!currentSession?.isExpanded) {
          return withRecoveredRoots;
        }
        const next = applyChildrenPage(
          withRecoveredRoots,
          sessionId,
          result.page,
          append && !result.recoveredRootPage
        );
        committedChildren =
          findSessionNode(next.sessions, sessionId)?.children ?? [];
        return next;
      });
      await loadPersistedExpandedChildren({
        sessions: committedChildren,
        loadChildren: (childSessionId) =>
          loadChildren(workspaceId, childSessionId, false)
      });
    } finally {
      if (mountedRef.current) {
        projectCollectionLoading(coordinator, scope);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const coordinator = coordinatorRef.current;
      if (coordinator) {
        for (const workspace of workspaceTreeRef.current) {
          coordinator.clearWorkspace(workspace.workspaceId);
        }
      }
    };
  }, []);

  useEffect(() => {
    const previousCoordinator = coordinatorRef.current;
    if (previousCoordinator) {
      for (const workspace of workspaceTreeRef.current) {
        clearCollectionLoading(
          previousCoordinator.clearWorkspace(workspace.workspaceId)
        );
      }
    }
    coordinatorRef.current = input.transport
      ? new SessionBrowserQueryCoordinator(input.transport.sessionBrowser)
      : undefined;
    refreshSignalRef.current = input.refreshSignal;
    if (!input.transport || !coordinatorRef.current) {
      workspaceListGenerationRef.current += 1;
      workspaceTreeRef.current = [];
      setWorkspaceTreeState([]);
      setAttentionSessions([]);
      return;
    }
    const requestGeneration = ++workspaceListGenerationRef.current;
    void Promise.all([
      input.transport.workspace.list(),
      input.transport.sessionBrowser.listTree()
    ]).then(([workspaceState, sessionTree]) => {
      if (
        !mountedRef.current ||
        requestGeneration !== workspaceListGenerationRef.current
      ) {
        return;
      }
      setAttentionSessions(collectAttentionSessions(sessionTree.workspaces));
      const current = mergeWorkspaceBrowserState(
        workspaceTreeRef.current,
        workspaceState
      );
      workspaceTreeRef.current = current;
      setWorkspaceTreeState(current);
      const startupWorkspaceIds = resolveStartupWorkspaceIds(workspaceState);
      void loadWorkspaceCatalogs({
        workspaceIds: startupWorkspaceIds,
        loadCatalog: loadRootPage
      }).catch((error) => {
        if (!mountedRef.current) {
          return;
        }
        input.onStatusNotice({
          message: `Session browser failed: ${(error as Error).message}`,
          persistent: true,
          source: "session-browser",
          ...statusNoticeErrorDetails(error)
        });
      });
    }).catch((error) => {
      if (!mountedRef.current) {
        return;
      }
      input.onStatusNotice({
        message: `Session browser failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-browser",
        ...statusNoticeErrorDetails(error)
      });
    });
  }, [input.transport]);

  useEffect(() => {
    if (refreshSignalRef.current === input.refreshSignal) {
      return;
    }
    refreshSignalRef.current = input.refreshSignal;
    if (!input.transport) {
      return;
    }
    void refreshSessionBrowser({ mode: "visible" }).catch((error) => {
      input.onStatusNotice({
        message: `Session browser failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-browser",
        ...statusNoticeErrorDetails(error)
      });
    });
  }, [input.transport, input.refreshSignal]);

  useEffect(() => {
    if (!input.focusSessionId || !input.transport) {
      return;
    }
    void ensureSessionVisible(input.focusSessionId).catch(() => undefined);
  }, [input.focusSessionId, input.transport]);

  return {
    workspaceTree,
    attentionSessions,
    refreshSessionBrowser,
    ensureSessionVisible,
    onAddWorkspace: async () => {
      if (!input.transport) {
        return;
      }
      await runAddWorkspaceFlow({
        transport: input.transport,
        onWorkspaceCommitted: (workspace) => {
          workspaceListGenerationRef.current += 1;
          const next = upsertWorkspaceBrowserRecord(
            workspaceTreeRef.current,
            workspace
          ).map((candidate) =>
            candidate.workspaceId === workspace.workspaceId
              ? { ...candidate, isExpanded: true }
              : candidate
          );
          workspaceTreeRef.current = next;
          setWorkspaceTreeState(next);
        },
        loadWorkspaceCatalog: loadRootPage,
        onStatusNotice: input.onStatusNotice
      });
    },
    onToggleWorkspace: async (workspaceId: string) => {
      if (!input.transport) {
        return;
      }
      const workspace = workspaceTreeRef.current.find(
        (candidate) => candidate.workspaceId === workspaceId
      );
      const expanded = !(workspace?.isExpanded ?? false);
      updateWorkspace(workspaceId, (current) => ({ ...current, isExpanded: expanded }));
      await runWorkspaceExpansionEffects({
        expanded,
        cancelLoads: () => {
          const coordinator = coordinatorRef.current;
          if (coordinator) {
            clearCollectionLoading(coordinator.cancelWorkspace(workspaceId));
          }
        },
        persistExpansion: () =>
          input.transport!.workspace.setExpanded(workspaceId, expanded),
        selectWorkspace: () => input.transport!.workspace.select(workspaceId),
        loadRoots: () => loadRootPage(workspaceId)
      });
    },
    onToggleSessionTree: async (sessionId: string, workspaceId?: string) => {
      if (!input.transport || !workspaceId) {
        return;
      }
      let expanded = false;
      let shouldLoad = false;
      updateWorkspace(workspaceId, (workspace) => {
        const toggled = toggleSessionTreeNode(workspace, sessionId);
        expanded = toggled.expanded;
        shouldLoad = toggled.shouldLoad;
        return toggled.workspace;
      });
      if (!expanded) {
        clearCollectionLoading(
          coordinatorRef.current?.cancelCollection({
            workspaceId,
            parentSessionId: sessionId
          }) ?? []
        );
      }
      await runSessionExpansionEffects({
        persistExpansion: () =>
          input.transport!.sessionBrowser.toggleExpanded(sessionId),
        loadChildren: shouldLoad
          ? () => loadChildren(workspaceId, sessionId, false)
          : undefined,
        onPersistenceError: (error) => {
          if (!mountedRef.current) {
            return;
          }
          input.onStatusNotice({
            message: `Session expansion preference failed: ${(error as Error).message}`,
            source: "session-browser",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    },
    onLoadMoreSessionChildren: async (sessionId: string, workspaceId: string) => {
      await loadChildren(workspaceId, sessionId, true);
    },
    onPreviousWorkspacePage: async (workspaceId: string) => {
      const workspace = workspaceTreeRef.current.find(
        (candidate) => candidate.workspaceId === workspaceId
      );
      if (!workspace || workspace.rootPageIndex <= 0) {
        return;
      }
      await loadRootPage(workspaceId, workspace.rootPageIndex - 1);
    },
    onNextWorkspacePage: async (workspaceId: string) => {
      const workspace = workspaceTreeRef.current.find(
        (candidate) => candidate.workspaceId === workspaceId
      );
      if (!workspace?.rootHasMore || !workspace.rootNextCursor) {
        return;
      }
      const nextPageIndex = workspace.rootPageIndex + 1;
      const cursorHistory = workspace.rootCursorHistory.slice(0, nextPageIndex);
      cursorHistory[nextPageIndex] = workspace.rootNextCursor;
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        rootCursorHistory: cursorHistory
      }));
      await loadRootPage(workspaceId, nextPageIndex, cursorHistory);
    }
  };
};
