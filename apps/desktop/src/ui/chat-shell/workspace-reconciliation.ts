import type { WorkspaceRecordRpc } from "@another-workbench/shared";

export const prioritizeWorkspaceIdsForReconciliation = (
  workspaces: WorkspaceRecordRpc[],
  lastActiveWorkspaceId?: string
): string[] => {
  const ordered = workspaces.map((workspace) => workspace.workspaceId);
  if (!lastActiveWorkspaceId) {
    return ordered;
  }
  return [
    lastActiveWorkspaceId,
    ...ordered.filter((workspaceId) => workspaceId !== lastActiveWorkspaceId)
  ];
};
