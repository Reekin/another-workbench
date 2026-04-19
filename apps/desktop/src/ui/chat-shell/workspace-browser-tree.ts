import type {
  WorkspaceBrowserNodeRpc,
  WorkspaceRecordRpc
} from "@another-workbench/shared";

export const mergeWorkspaceBrowserTree = (
  previous: WorkspaceBrowserNodeRpc[],
  workspaceState: {
    workspaces: WorkspaceRecordRpc[];
    lastActiveWorkspaceId?: string;
  },
  loadedById: Map<string, WorkspaceBrowserNodeRpc>
): WorkspaceBrowserNodeRpc[] => {
  const previousById = new Map(
    previous.map((workspace) => [workspace.workspaceId, workspace] as const)
  );

  return workspaceState.workspaces.map((workspace) => {
    const loaded = loadedById.get(workspace.workspaceId);
    const previousNode = previousById.get(workspace.workspaceId);
    return {
      workspaceId: workspace.workspaceId,
      label: workspace.label,
      rootPath: workspace.absolutePath,
      isExpanded:
        loaded?.isExpanded ??
        previousNode?.isExpanded ??
        workspaceState.lastActiveWorkspaceId === workspace.workspaceId,
      isActive: workspaceState.lastActiveWorkspaceId === workspace.workspaceId,
      sessions: loaded?.sessions ?? previousNode?.sessions ?? []
    };
  });
};

export const findSessionNode = (
  workspaces: WorkspaceBrowserNodeRpc[],
  sessionId: string
): WorkspaceBrowserNodeRpc["sessions"][number] | undefined => {
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
  workspaces: WorkspaceBrowserNodeRpc[]
): WorkspaceBrowserNodeRpc["sessions"][number] | undefined => {
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
