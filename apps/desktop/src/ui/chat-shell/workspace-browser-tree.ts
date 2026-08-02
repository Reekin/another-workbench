import type {
  SessionBrowserItemRpc,
  SessionBrowserPageRpc,
  SessionBrowserPathRpc,
  WorkspaceRecordRpc
} from "@another-workbench/shared";

export type SessionBrowserViewNode = SessionBrowserItemRpc & {
  workspaceId: string;
  isExpanded: boolean;
  isLoadingChildren: boolean;
  hasLoadedChildren: boolean;
  children: SessionBrowserViewNode[];
  childrenNextCursor?: string;
  childrenHasMore: boolean;
};

export type WorkspaceBrowserViewNode = {
  workspaceId: string;
  label: string;
  rootPath: string;
  isExpanded: boolean;
  isActive: boolean;
  sessions: SessionBrowserViewNode[];
  rootCursorHistory: Array<string | undefined>;
  rootPageIndex: number;
  rootRevision?: string;
  rootNextCursor?: string;
  rootHasMore: boolean;
  rootTotalCount: number;
  isLoadingRoots: boolean;
  isDirty: boolean;
};

const createWorkspaceBrowserViewNode = (
  workspace: WorkspaceRecordRpc,
  isActive: boolean,
  previous?: WorkspaceBrowserViewNode
): WorkspaceBrowserViewNode => ({
  workspaceId: workspace.workspaceId,
  label: workspace.label,
  rootPath: workspace.absolutePath,
  isExpanded: previous?.isExpanded ?? isActive,
  isActive,
  sessions: previous?.sessions ?? [],
  rootCursorHistory: previous?.rootCursorHistory ?? [undefined],
  rootPageIndex: previous?.rootPageIndex ?? 0,
  rootRevision: previous?.rootRevision,
  rootNextCursor: previous?.rootNextCursor,
  rootHasMore: previous?.rootHasMore ?? false,
  rootTotalCount: previous?.rootTotalCount ?? 0,
  isLoadingRoots: previous?.isLoadingRoots ?? false,
  isDirty: previous?.isDirty ?? true
});

export const createSessionBrowserViewNode = (
  item: SessionBrowserItemRpc,
  workspaceId: string,
  previous?: SessionBrowserViewNode
): SessionBrowserViewNode => ({
  ...item,
  workspaceId,
  isExpanded: previous?.isExpanded ?? false,
  isLoadingChildren: previous?.isLoadingChildren ?? false,
  hasLoadedChildren: previous?.hasLoadedChildren ?? false,
  children: previous?.children ?? [],
  childrenNextCursor: previous?.childrenNextCursor,
  childrenHasMore: previous?.childrenHasMore ?? item.childCount > 0
});

export const mergeWorkspaceBrowserState = (
  previous: WorkspaceBrowserViewNode[],
  workspaceState: {
    workspaces: WorkspaceRecordRpc[];
    lastActiveWorkspaceId?: string;
  }
): WorkspaceBrowserViewNode[] => {
  const previousById = new Map(
    previous.map((workspace) => [workspace.workspaceId, workspace] as const)
  );
  return workspaceState.workspaces.map((workspace) => {
    const previousNode = previousById.get(workspace.workspaceId);
    const isActive = workspaceState.lastActiveWorkspaceId === workspace.workspaceId;
    return createWorkspaceBrowserViewNode(workspace, isActive, previousNode);
  });
};

export const upsertWorkspaceBrowserRecord = (
  previous: WorkspaceBrowserViewNode[],
  workspace: WorkspaceRecordRpc
): WorkspaceBrowserViewNode[] => {
  const existingIndex = previous.findIndex(
    (candidate) => candidate.workspaceId === workspace.workspaceId
  );
  if (existingIndex < 0) {
    return [...previous, createWorkspaceBrowserViewNode(workspace, false)];
  }
  return previous.map((candidate, index) =>
    index === existingIndex
      ? createWorkspaceBrowserViewNode(workspace, candidate.isActive, candidate)
      : candidate
  );
};

export const applyRootPage = (
  workspace: WorkspaceBrowserViewNode,
  page: SessionBrowserPageRpc,
  pageIndex: number,
  cursorHistory: Array<string | undefined>
): WorkspaceBrowserViewNode => {
  const previousById = new Map(
    workspace.sessions.map((session) => [session.sessionId, session] as const)
  );
  return {
    ...workspace,
    sessions: page.items.map((item) =>
      createSessionBrowserViewNode(item, workspace.workspaceId, previousById.get(item.sessionId))
    ),
    rootCursorHistory: cursorHistory,
    rootPageIndex: pageIndex,
    rootRevision: page.revision,
    rootNextCursor: page.nextCursor,
    rootHasMore: page.hasMore,
    rootTotalCount: page.totalCount,
    isLoadingRoots: false,
    isDirty: false
  };
};

export const resetRootPagination = (
  workspace: WorkspaceBrowserViewNode
): WorkspaceBrowserViewNode => ({
  ...workspace,
  rootCursorHistory: [undefined],
  rootPageIndex: 0,
  rootRevision: undefined,
  rootNextCursor: undefined,
  rootHasMore: false,
  isLoadingRoots: false,
  isDirty: true
});

export const setRootLoading = (
  workspace: WorkspaceBrowserViewNode,
  isLoadingRoots: boolean
): WorkspaceBrowserViewNode => ({
  ...workspace,
  isLoadingRoots
});

const updateSessionNodes = (
  sessions: SessionBrowserViewNode[],
  sessionId: string,
  update: (session: SessionBrowserViewNode) => SessionBrowserViewNode
): SessionBrowserViewNode[] => {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.sessionId === sessionId) {
      changed = true;
      return update(session);
    }
    const children = updateSessionNodes(session.children, sessionId, update);
    if (children !== session.children) {
      changed = true;
      return { ...session, children };
    }
    return session;
  });
  return changed ? next : sessions;
};

export const updateSessionNode = (
  workspace: WorkspaceBrowserViewNode,
  sessionId: string,
  update: (session: SessionBrowserViewNode) => SessionBrowserViewNode
): WorkspaceBrowserViewNode => {
  const sessions = updateSessionNodes(workspace.sessions, sessionId, update);
  return sessions === workspace.sessions ? workspace : { ...workspace, sessions };
};

export const setSessionChildrenLoading = (
  workspace: WorkspaceBrowserViewNode,
  sessionId: string,
  isLoadingChildren: boolean
): WorkspaceBrowserViewNode =>
  updateSessionNode(workspace, sessionId, (session) => ({
    ...session,
    isLoadingChildren
  }));

export const applyChildrenPage = (
  workspace: WorkspaceBrowserViewNode,
  parentSessionId: string,
  page: SessionBrowserPageRpc,
  append: boolean
): WorkspaceBrowserViewNode =>
  updateSessionNode(workspace, parentSessionId, (parent) => {
    const previousById = new Map(
      parent.children.map((child) => [child.sessionId, child] as const)
    );
    const incoming = page.items.map((item) =>
      createSessionBrowserViewNode(item, workspace.workspaceId, previousById.get(item.sessionId))
    );
    const children = append
      ? [
          ...parent.children,
          ...incoming.filter(
            (item) => !parent.children.some((child) => child.sessionId === item.sessionId)
          )
        ]
      : incoming;
    return {
      ...parent,
      children,
      hasLoadedChildren: true,
      childrenNextCursor: page.nextCursor,
      childrenHasMore: page.hasMore,
      isLoadingChildren: false
    };
  });

export const mergeSessionPath = (
  workspace: WorkspaceBrowserViewNode,
  path: SessionBrowserPathRpc
): WorkspaceBrowserViewNode => {
  if (path.workspaceId !== workspace.workspaceId || path.items.length === 0) {
    return workspace;
  }
  const mergeAtDepth = (
    sessions: SessionBrowserViewNode[],
    depth: number
  ): SessionBrowserViewNode[] => {
    const item = path.items[depth];
    if (!item) {
      return sessions;
    }
    const existingIndex = sessions.findIndex((session) => session.sessionId === item.sessionId);
    const existing = existingIndex >= 0 ? sessions[existingIndex] : undefined;
    let node = createSessionBrowserViewNode(item, workspace.workspaceId, existing);
    if (depth < path.items.length - 1) {
      node = {
        ...node,
        isExpanded: true,
        children: mergeAtDepth(node.children, depth + 1)
      };
    }
    if (existingIndex < 0) {
      return [node, ...sessions];
    }
    const next = [...sessions];
    next[existingIndex] = node;
    return next;
  };
  return {
    ...workspace,
    isExpanded: true,
    sessions: mergeAtDepth(workspace.sessions, 0)
  };
};

export const findSessionNode = (
  workspaces: WorkspaceBrowserViewNode[],
  sessionId: string
): SessionBrowserViewNode | undefined => {
  for (const workspace of workspaces) {
    const stack = [...workspace.sessions];
    while (stack.length > 0) {
      const session = stack.pop();
      if (!session) {
        continue;
      }
      if (session.sessionId === sessionId) {
        return session;
      }
      stack.push(...session.children);
    }
  }
  return undefined;
};

export const findActiveSessionNode = (
  workspaces: WorkspaceBrowserViewNode[]
): SessionBrowserViewNode | undefined => {
  for (const workspace of workspaces) {
    const stack = [...workspace.sessions];
    while (stack.length > 0) {
      const session = stack.pop();
      if (!session) {
        continue;
      }
      if (session.isActive) {
        return session;
      }
      stack.push(...session.children);
    }
  }
  return undefined;
};
