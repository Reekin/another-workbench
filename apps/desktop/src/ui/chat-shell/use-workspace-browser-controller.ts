import { useEffect, useRef, useState } from "react";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { prioritizeWorkspaceIdsForReconciliation } from "./workspace-reconciliation.js";
import {
  isSessionBrowserCursorStaleError,
  SessionBrowserQueryCoordinator
} from "./session-browser-query-coordinator.js";
import type { SessionBrowserPageQuery } from "./session-browser-query-coordinator.js";
import {
  applyChildrenPage,
  applyRootPage,
  mergeSessionPath,
  mergeWorkspaceBrowserState,
  resetRootPagination,
  updateSessionNode,
  type WorkspaceBrowserViewNode
} from "./workspace-browser-tree.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

const rootPageSize = 10;
const childPageSize = 20;

export type WorkspaceBrowserController = {
  workspaceTree: WorkspaceBrowserViewNode[];
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
  openingSessionId?: string;
  onStatusNotice: StatusNoticeSetter;
}): WorkspaceBrowserController => {
  const [workspaceTree, setWorkspaceTreeState] = useState<WorkspaceBrowserViewNode[]>([]);
  const workspaceTreeRef = useRef<WorkspaceBrowserViewNode[]>([]);
  const coordinatorRef = useRef<SessionBrowserQueryCoordinator | undefined>(undefined);
  const reconcileQueueRef = useRef<string[]>([]);
  const reconcileQueuedIdsRef = useRef(new Set<string>());
  const reconcileAttemptedIdsRef = useRef(new Set<string>());
  const reconcileRunningRef = useRef(false);
  const mountedRef = useRef(true);
  const openingSessionIdRef = useRef<string | undefined>(undefined);

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

  const loadAcceptedPage = async (query: SessionBrowserPageQuery) => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) {
      return undefined;
    }
    await coordinator.load(query);
    let accepted = coordinator.getCached(query);
    if (!accepted) {
      await coordinator.load(query);
      accepted = coordinator.getCached(query);
    }
    return accepted;
  };

  const loadRootPage = async (
    workspaceId: string,
    pageIndex?: number,
    cursorHistoryOverride?: Array<string | undefined>,
    allowCursorReset = true
  ): Promise<void> => {
    const workspace = workspaceTreeRef.current.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace?.isExpanded) {
      return;
    }
    const targetPageIndex = pageIndex ?? workspace.rootPageIndex;
    const cursorHistory =
      cursorHistoryOverride ??
      (workspace.rootCursorHistory.length > 0
        ? workspace.rootCursorHistory
        : [undefined]);
    const cursor = cursorHistory[targetPageIndex];
    updateWorkspace(workspaceId, (current) => ({ ...current, isLoadingRoots: true }));
    try {
      const page = await loadAcceptedPage({
        kind: "roots",
        workspaceId,
        cursor,
        limit: rootPageSize
      });
      if (!page || !mountedRef.current) {
        return;
      }
      updateWorkspace(workspaceId, (current) =>
        applyRootPage(current, page, targetPageIndex, cursorHistory)
      );
      if (input.focusSessionId) {
        await ensureSessionVisible(input.focusSessionId).catch(() => undefined);
      }
    } catch (error) {
      if (allowCursorReset && isSessionBrowserCursorStaleError(error)) {
        coordinatorRef.current?.clearWorkspace(workspaceId);
        updateWorkspace(workspaceId, resetRootPagination);
        await loadRootPage(workspaceId, 0, [undefined], false);
        return;
      }
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        isLoadingRoots: false,
        isDirty: true
      }));
      throw error;
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
      workspaceTreeRef.current = [];
      setWorkspaceTreeState([]);
      return;
    }
    const workspaceState = await input.transport.workspace.list();
    setWorkspaceTree((current) => mergeWorkspaceBrowserState(current, workspaceState));
    const current = mergeWorkspaceBrowserState(workspaceTreeRef.current, workspaceState);
    workspaceTreeRef.current = current;
    const mode = refreshInput?.mode ?? "visible";
    const targetWorkspaceId =
      mode === "workspace"
        ? refreshInput?.workspaceId
        : workspaceState.lastActiveWorkspaceId;

    if (mode === "all" || mode === "visible") {
      for (const workspace of current) {
        coordinatorRef.current.invalidateWorkspace(workspace.workspaceId);
      }
      setWorkspaceTree((workspaces) =>
        workspaces.map(resetRootPagination)
      );
    } else if (targetWorkspaceId) {
      coordinatorRef.current.invalidateWorkspace(targetWorkspaceId);
      updateWorkspace(targetWorkspaceId, resetRootPagination);
    }

    if (targetWorkspaceId) {
      await loadRootPage(targetWorkspaceId);
    }

    const reconciliationCandidates = prioritizeWorkspaceIdsForReconciliation(
      workspaceState.workspaces,
      workspaceState.lastActiveWorkspaceId
    );
    for (const workspaceId of reconciliationCandidates) {
      if (
        reconcileAttemptedIdsRef.current.has(workspaceId) ||
        reconcileQueuedIdsRef.current.has(workspaceId)
      ) {
        continue;
      }
      reconcileQueueRef.current.push(workspaceId);
      reconcileQueuedIdsRef.current.add(workspaceId);
    }
  };

  const loadChildren = async (
    workspaceId: string,
    sessionId: string,
    append: boolean
  ): Promise<void> => {
    const workspace = workspaceTreeRef.current.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    const findNode = (sessions: WorkspaceBrowserViewNode["sessions"]): WorkspaceBrowserViewNode["sessions"][number] | undefined => {
      for (const session of sessions) {
        if (session.sessionId === sessionId) {
          return session;
        }
        const child = findNode(session.children);
        if (child) {
          return child;
        }
      }
      return undefined;
    };
    const session = workspace ? findNode(workspace.sessions) : undefined;
    if (!workspace || !session) {
      return;
    }
    const cursor = append ? session.childrenNextCursor : undefined;
    updateWorkspace(workspaceId, (current) =>
      updateSessionNode(current, sessionId, (node) => ({
        ...node,
        isLoadingChildren: true
      }))
    );
    try {
      const page = await loadAcceptedPage({
        kind: "children",
        workspaceId,
        parentSessionId: sessionId,
        cursor,
        limit: childPageSize
      });
      if (!page || !mountedRef.current) {
        return;
      }
      updateWorkspace(workspaceId, (current) =>
        applyChildrenPage(current, sessionId, page, append)
      );
    } catch (error) {
      if (isSessionBrowserCursorStaleError(error)) {
        coordinatorRef.current?.clearWorkspace(workspaceId);
        updateWorkspace(workspaceId, resetRootPagination);
        await loadRootPage(workspaceId, 0, [undefined], false);
        return;
      }
      updateWorkspace(workspaceId, (current) =>
        updateSessionNode(current, sessionId, (node) => ({
          ...node,
          isLoadingChildren: false
        }))
      );
      throw error;
    }
  };

  const runBackgroundReconciliation = async (): Promise<void> => {
    if (!input.transport || reconcileRunningRef.current) {
      return;
    }
    reconcileRunningRef.current = true;
    try {
      while (reconcileQueueRef.current.length > 0) {
        if (openingSessionIdRef.current) {
          break;
        }
        const workspaceId = reconcileQueueRef.current.shift();
        if (!workspaceId) {
          continue;
        }
        reconcileQueuedIdsRef.current.delete(workspaceId);
        reconcileAttemptedIdsRef.current.add(workspaceId);
        try {
          await input.transport.sessionBrowser.reconcile(workspaceId);
          coordinatorRef.current?.invalidateWorkspace(workspaceId);
          updateWorkspace(workspaceId, (workspace) => ({ ...workspace, isDirty: true }));
          const workspace = workspaceTreeRef.current.find(
            (candidate) => candidate.workspaceId === workspaceId
          );
          if (workspace?.isExpanded && workspace.isActive) {
            await loadRootPage(workspaceId);
          }
        } catch (error) {
          if (!mountedRef.current) {
            return;
          }
          input.onStatusNotice({
            message: `Background session sync failed: ${(error as Error).message}`,
            source: "session-browser",
            ...statusNoticeErrorDetails(error)
          });
        }
      }
    } finally {
      reconcileRunningRef.current = false;
      if (reconcileQueueRef.current.length > 0 && mountedRef.current) {
        void runBackgroundReconciliation();
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    openingSessionIdRef.current = input.openingSessionId;
  }, [input.openingSessionId]);

  useEffect(() => {
    coordinatorRef.current = input.transport
      ? new SessionBrowserQueryCoordinator(input.transport.sessionBrowser)
      : undefined;
    reconcileQueueRef.current = [];
    reconcileQueuedIdsRef.current = new Set();
    reconcileAttemptedIdsRef.current = new Set();
    reconcileRunningRef.current = false;
  }, [input.transport]);

  useEffect(() => {
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

  useEffect(() => {
    if (!input.transport || reconcileQueueRef.current.length === 0 || input.openingSessionId) {
      return;
    }
    void runBackgroundReconciliation();
  }, [input.transport, workspaceTree, input.openingSessionId]);

  return {
    workspaceTree,
    refreshSessionBrowser,
    ensureSessionVisible,
    onAddWorkspace: async () => {
      if (!input.transport) {
        return;
      }
      try {
        const picked = await input.transport.workspace.pickDirectory();
        if (picked.canceled || !picked.rootPath) {
          return;
        }
        const rootPath = picked.rootPath;
        const workspace = await input.transport.workspace.add({ rootPath });
        await input.transport.sessionBrowser.reconcile(workspace.workspaceId);
        await refreshSessionBrowser({ mode: "all" });
        input.onStatusNotice({
          message: `Added workspace ${rootPath}`,
          source: "workspace-add"
        });
      } catch (error) {
        input.onStatusNotice({
          message: `Add workspace failed: ${(error as Error).message}`,
          persistent: true,
          source: "workspace-add",
          ...statusNoticeErrorDetails(error)
        });
      }
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
      await input.transport.workspace.select(workspaceId);
      await input.transport.workspace.toggleExpanded(workspaceId);
      if (expanded) {
        await loadRootPage(workspaceId);
      }
    },
    onToggleSessionTree: async (sessionId: string, workspaceId?: string) => {
      if (!input.transport || !workspaceId) {
        return;
      }
      let expanded = false;
      let shouldLoad = false;
      updateWorkspace(workspaceId, (workspace) =>
        updateSessionNode(workspace, sessionId, (session) => {
          expanded = !session.isExpanded;
          shouldLoad = expanded && !session.hasLoadedChildren;
          return { ...session, isExpanded: expanded };
        })
      );
      await input.transport.sessionBrowser.toggleExpanded(sessionId);
      if (shouldLoad) {
        await loadChildren(workspaceId, sessionId, false);
      }
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
