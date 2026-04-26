import { useEffect, useRef, useState } from "react";
import type { WorkspaceBrowserNodeRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { prioritizeWorkspaceIdsForReconciliation } from "./workspace-reconciliation.js";
import { mergeWorkspaceBrowserTree } from "./workspace-browser-tree.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export type WorkspaceBrowserController = {
  workspaceTree: WorkspaceBrowserNodeRpc[];
  refreshSessionBrowser: (input?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }) => Promise<void>;
  onAddWorkspace: () => Promise<void>;
  onToggleWorkspace: (workspaceId: string) => Promise<void>;
  onToggleSessionTree: (sessionId: string, workspaceId?: string) => Promise<void>;
};

export const useWorkspaceBrowserController = (input: {
  transport?: DesktopTransport;
  eventCursor?: string;
  openingSessionId?: string;
  onStatusNotice: StatusNoticeSetter;
}): WorkspaceBrowserController => {
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceBrowserNodeRpc[]>([]);
  const reconcileQueueRef = useRef<string[]>([]);
  const reconcileQueuedIdsRef = useRef(new Set<string>());
  const reconcileAttemptedIdsRef = useRef(new Set<string>());
  const reconcileRunningRef = useRef(false);
  const mountedRef = useRef(true);
  const openingSessionIdRef = useRef<string | undefined>(undefined);

  const refreshSessionBrowser = async (refreshInput?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }): Promise<void> => {
    if (!input.transport) {
      setWorkspaceTree([]);
      return;
    }
    const workspaceState = await input.transport.workspace.list();
    const visibleWorkspaceIds = new Set(
      workspaceTree
        .filter((workspace) => workspace.isExpanded || workspace.isActive)
        .map((workspace) => workspace.workspaceId)
    );
    if (workspaceState.lastActiveWorkspaceId) {
      visibleWorkspaceIds.add(workspaceState.lastActiveWorkspaceId);
    }

    const mode = refreshInput?.mode ?? "visible";
    const workspaceIdsToLoad =
      mode === "all"
        ? workspaceState.workspaces.map((workspace) => workspace.workspaceId)
        : mode === "workspace" && refreshInput?.workspaceId
          ? [refreshInput.workspaceId]
          : [...visibleWorkspaceIds];

    const loadedWorkspaces = await Promise.all(
      workspaceIdsToLoad.map(async (workspaceId) => {
        const tree = await input.transport?.sessionBrowser.listTree(workspaceId);
        return tree?.workspaces[0];
      })
    );

    setWorkspaceTree((current) =>
      mergeWorkspaceBrowserTree(
        current,
        workspaceState,
        new Map(
          loadedWorkspaces
            .filter((workspace): workspace is WorkspaceBrowserNodeRpc => Boolean(workspace))
            .map((workspace) => [workspace.workspaceId, workspace] as const)
        )
      )
    );

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
          if (!mountedRef.current) {
            return;
          }
          await refreshSessionBrowser({
            mode: "workspace",
            workspaceId
          });
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
    reconcileQueueRef.current = [];
    reconcileQueuedIdsRef.current = new Set();
    reconcileAttemptedIdsRef.current = new Set();
    reconcileRunningRef.current = false;
  }, [input.transport]);

  useEffect(() => {
    if (!input.transport) {
      return;
    }
    void refreshSessionBrowser({
      mode: "visible"
    }).catch((error) => {
      input.onStatusNotice({
        message: `Session browser failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-browser",
        ...statusNoticeErrorDetails(error)
      });
    });
  }, [input.transport, input.eventCursor]);

  useEffect(() => {
    if (!input.transport || reconcileQueueRef.current.length === 0 || input.openingSessionId) {
      return;
    }
    void runBackgroundReconciliation();
  }, [input.transport, workspaceTree, input.openingSessionId]);

  return {
    workspaceTree,
    refreshSessionBrowser,
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
        const workspace = await input.transport.workspace.add({
          rootPath
        });
        await input.transport.sessionBrowser.reconcile(workspace.workspaceId);
        await refreshSessionBrowser({
          mode: "all"
        });
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
      await input.transport.workspace.select(workspaceId);
      await input.transport.workspace.toggleExpanded(workspaceId);
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId
      });
    },
    onToggleSessionTree: async (sessionId: string, workspaceId?: string) => {
      if (!input.transport) {
        return;
      }
      await input.transport.sessionBrowser.toggleExpanded(sessionId);
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId
      });
    }
  };
};
