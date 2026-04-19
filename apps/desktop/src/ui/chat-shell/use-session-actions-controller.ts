import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SessionActionDescriptorRpc, WorkspaceBrowserNodeRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ComposerStatusNotice } from "./composer-status.js";
import { findSessionNode } from "./workspace-browser-tree.js";

export type SessionMenuState = {
  sessionId: string;
  x: number;
  y: number;
  actions: SessionActionDescriptorRpc[];
};

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export const useSessionActionsController = (input: {
  transport?: DesktopTransport;
  workspaceTree: WorkspaceBrowserNodeRpc[];
  refreshSessionBrowser: (input?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }) => Promise<void>;
  onStatusNotice: StatusNoticeSetter;
}): {
  sessionMenu: SessionMenuState | undefined;
  onOpenSessionMenu: (event: ReactMouseEvent, sessionId: string) => Promise<void>;
  onRunSessionAction: (
    sessionId: string,
    action: SessionActionDescriptorRpc["action"]
  ) => Promise<void>;
} => {
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | undefined>();

  useEffect(() => {
    const handleWindowClick = () => setSessionMenu(undefined);
    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, []);

  return {
    sessionMenu,
    onOpenSessionMenu: async (
      event: ReactMouseEvent,
      sessionId: string
    ): Promise<void> => {
      if (!input.transport) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const result = await input.transport.sessionBrowser.getActions(sessionId);
      setSessionMenu({
        sessionId,
        x: event.clientX,
        y: event.clientY,
        actions: result.actions
      });
    },
    onRunSessionAction: async (
      sessionId: string,
      action: SessionActionDescriptorRpc["action"]
    ): Promise<void> => {
      if (!input.transport) {
        return;
      }
      try {
        const result = await input.transport.sessionBrowser.runAction({
          sessionId,
          action
        });
        setSessionMenu(undefined);
        await input.refreshSessionBrowser({
          mode: "workspace",
          workspaceId: findSessionNode(input.workspaceTree, sessionId)?.workspaceId
        });
        if (result.action === "copy_session_id") {
          await navigator.clipboard?.writeText(result.copiedText);
          input.onStatusNotice({
            message: `Copied ${result.copiedText}`,
            source: "session-action"
          });
          return;
        }
        if (result.action === "open_rollout") {
          window.open(result.rolloutFileUrl, "_blank", "noopener,noreferrer");
          input.onStatusNotice({
            message: `Opened rollout ${result.rolloutDisplayPath}`,
            source: "session-action"
          });
          return;
        }
        input.onStatusNotice({
          message: `${action} completed.`,
          source: "session-action"
        });
      } catch (error) {
        input.onStatusNotice({
          message: `${action} failed: ${(error as Error).message}`,
          persistent: true,
          source: "session-action"
        });
      }
    }
  };
};
