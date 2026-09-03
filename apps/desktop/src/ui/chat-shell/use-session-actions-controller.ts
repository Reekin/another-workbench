import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SessionActionDescriptorRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";
import {
  findSessionNode,
  type WorkspaceBrowserViewNode
} from "./workspace-browser-tree.js";
import type { SessionBrowserRefreshInput } from "./use-workspace-browser-controller.js";

export type SessionMenuState = {
  sessionId: string;
  x: number;
  y: number;
  actions: SessionActionDescriptorRpc[];
};

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export const shouldDismissFloatingMenuForContextMenu = (
  event: MouseEvent
): boolean => {
  const target = event.target;
  return !(
    typeof Element !== "undefined" &&
    target instanceof Element &&
    target.closest(".awb-session-menu")
  );
};

export const formatSessionCopyStatusNotice = (
  action: "copy_session_id" | "copy_awb_session_id",
  copiedText: string
): string =>
  action === "copy_awb_session_id"
    ? `Copied AWB session id ${copiedText}`
    : `Copied session id ${copiedText}`;

export const writeSessionActionClipboardText = async (
  text: string
): Promise<void> => {
  const desktopWriter = window.workbenchDesktop?.writeClipboardText;
  if (desktopWriter) {
    await desktopWriter(text);
    return;
  }

  if (!navigator.clipboard) {
    throw new Error("Clipboard API is unavailable.");
  }
  await navigator.clipboard.writeText(text);
};

export const useSessionActionsController = (input: {
  transport?: DesktopTransport;
  workspaceTree: WorkspaceBrowserViewNode[];
  refreshSessionBrowser: (input?: SessionBrowserRefreshInput) => Promise<void>;
  onOpenSession?: (sessionId: string) => Promise<void>;
  onResumeSession?: (
    sessionId: string,
    options?: {
      forceProviderHydration?: boolean;
    }
  ) => Promise<void>;
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
    const handleWindowContextMenu = (event: MouseEvent) => {
      if (shouldDismissFloatingMenuForContextMenu(event)) {
        setSessionMenu(undefined);
      }
    };
    window.addEventListener("click", handleWindowClick);
    window.addEventListener("contextmenu", handleWindowContextMenu, true);
    return () => {
      window.removeEventListener("click", handleWindowClick);
      window.removeEventListener("contextmenu", handleWindowContextMenu, true);
    };
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
      setSessionMenu(undefined);
      try {
        const result = await input.transport.sessionBrowser.runAction({
          sessionId,
          action
        });
        if (
          result.action === "copy_session_id" ||
          result.action === "copy_awb_session_id"
        ) {
          await writeSessionActionClipboardText(result.copiedText);
          input.onStatusNotice({
            message: formatSessionCopyStatusNotice(result.action, result.copiedText),
            source: "session-action"
          });
          return;
        }
        const workspaceId = findSessionNode(input.workspaceTree, sessionId)?.workspaceId;
        await input.refreshSessionBrowser(
          workspaceId
            ? {
                mode: "workspace",
                workspaceId
              }
            : {
                mode: "visible"
              }
        );
        if (result.action === "open_rollout") {
          window.open(result.rolloutFileUrl, "_blank", "noopener,noreferrer");
          input.onStatusNotice({
            message: `Opened rollout ${result.rolloutDisplayPath}`,
            source: "session-action"
          });
          return;
        }
        if (result.action === "pin" || result.action === "unpin") {
          input.onStatusNotice({
            message: result.pinned ? "Session pinned." : "Session unpinned.",
            source: "session-action"
          });
          return;
        }
        if (result.action === "resume") {
          await input.onResumeSession?.(sessionId, {
            forceProviderHydration: true
          });
          input.onStatusNotice({
            message: "Resume completed.",
            source: "session-action"
          });
          return;
        }
        if (result.action === "fork") {
          if (result.status === "unsupported") {
            input.onStatusNotice({
              message: result.message ?? "Fork is not supported for this session.",
              persistent: true,
              source: "session-action"
            });
            return;
          }
          if (!result.forkedSessionId) {
            throw new Error("Fork response did not include a child session id.");
          }
          await input.onOpenSession?.(result.forkedSessionId);
          input.onStatusNotice({
            message: "Fork created.",
            source: "session-action"
          });
          return;
        }
        if (result.action === "refresh") {
          input.onStatusNotice({
            message: result.details ?? "Refresh completed.",
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
          source: "session-action",
          ...statusNoticeErrorDetails(error)
        });
      }
    }
  };
};
