import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction
} from "react";
import type { SessionWindowRpc, WorkspaceBrowserNodeRpc } from "@another-workbench/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ComposerStatusNotice } from "./composer-status.js";
import type { TranscriptViewportController } from "./use-transcript-viewport-controller.js";
import { findSessionNode } from "./workspace-browser-tree.js";

type StatusNoticeSetter = Dispatch<
  SetStateAction<ComposerStatusNotice | undefined>
>;

export const useSessionOpenController = (input: {
  store: RendererStore;
  transport?: DesktopTransport;
  workspaceTree: WorkspaceBrowserNodeRpc[];
  sessionWindows: Record<string, SessionWindowRpc | undefined>;
  setSessionWindows: Dispatch<
    SetStateAction<Record<string, SessionWindowRpc | undefined>>
  >;
  loadingOlderSessionId?: string;
  setLoadingOlderSessionId: Dispatch<SetStateAction<string | undefined>>;
  browserSelectedSessionId?: string;
  setBrowserSelectedSessionId: Dispatch<SetStateAction<string | undefined>>;
  openingSessionId?: string;
  setOpeningSessionId: Dispatch<SetStateAction<string | undefined>>;
  displayedSessionId?: string;
  activeSessionWindow?: SessionWindowRpc;
  isOpeningSelectedSession: boolean;
  viewport: TranscriptViewportController;
  onResetSessionSwitchState: () => void;
  onStatusNotice: StatusNoticeSetter;
  refreshSessionBrowser: (input?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }) => Promise<void>;
  onReleasedSession?: (sessionId: string | undefined) => void;
}): {
  reloadSessionWindow: (sessionId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onCreateSession: (workspaceId: string, agentId: string) => Promise<void>;
  onOpenSession: (sessionId: string) => Promise<void>;
} => {
  const openSessionRequestIdRef = useRef(0);

  const activateLoadedSession = (sessionId: string): boolean => {
    const session = input.store.getState().entities.sessions[sessionId];
    if (!session) {
      return false;
    }
    input.store.dispatch({
      type: "store/setActiveConversation",
      conversationId: session.conversationId
    });
    input.store.dispatch({
      type: "store/setActiveSession",
      sessionId
    });
    return true;
  };

  const releaseSessionCache = async (
    sessionId: string | undefined
  ): Promise<void> => {
    if (!sessionId) {
      return;
    }
    input.store.disposeSession(sessionId);
    input.setSessionWindows((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    input.viewport.clearPendingViewportState();
    input.onReleasedSession?.(sessionId);
  };

  const applySessionWindow = (
    page: SessionWindowRpc,
    mode: "replace" | "prepend" = "replace",
    options: {
      activate?: boolean;
    } = {}
  ): void => {
    input.store.hydrateSessionWindow(page.sessionId, page.snapshot, mode);
    input.setSessionWindows((current) => {
      const existing = current[page.sessionId];
      if (mode === "prepend" && existing?.sessionId === page.sessionId) {
        return {
          ...current,
          [page.sessionId]: {
            ...existing,
            windowStartTurnId: page.windowStartTurnId ?? existing.windowStartTurnId,
            hasOlder: page.hasOlder,
            snapshot: existing.snapshot,
            hasNewer: existing.hasNewer
          }
        };
      }
      return {
        ...current,
        [page.sessionId]: page
      };
    });
    if (mode === "replace") {
      input.viewport.queueViewportTarget({
        sessionId: page.sessionId,
        type: page.windowEndTurnId && page.hasNewer ? "turn" : "bottom",
        turnId: page.windowEndTurnId && page.hasNewer ? page.windowEndTurnId : undefined
      });
    }
    if (options.activate ?? true) {
      activateLoadedSession(page.sessionId);
    }
  };

  const hydrateOpenedSession = async (
    sessionId: string,
    requestId: number
  ): Promise<void> => {
    if (!input.transport) {
      return;
    }
    const result = await input.transport.sessionBrowser.open(sessionId);
    if (openSessionRequestIdRef.current !== requestId) {
      return;
    }
    applySessionWindow(result.page, "replace");
  };

  useEffect(() => {
    if (!input.openingSessionId) {
      return;
    }
    if (!input.sessionWindows[input.openingSessionId]) {
      return;
    }
    input.setOpeningSessionId((current) =>
      current === input.openingSessionId ? undefined : current
    );
    input.onStatusNotice((current) =>
      current?.source === "session-browser" ? undefined : current
    );
  }, [
    input.openingSessionId,
    input.sessionWindows,
    input.setOpeningSessionId,
    input.onStatusNotice
  ]);

  return {
    reloadSessionWindow: async (sessionId: string) => {
      const requestId = ++openSessionRequestIdRef.current;
      await hydrateOpenedSession(sessionId, requestId);
    },
    onLoadOlder: async () => {
      if (
        !input.transport ||
        !input.displayedSessionId ||
        !input.activeSessionWindow?.hasOlder ||
        !input.activeSessionWindow.windowStartTurnId ||
        input.loadingOlderSessionId === input.displayedSessionId ||
        input.isOpeningSelectedSession
      ) {
        return;
      }

      const element = input.viewport.transcriptRef.current;
      const previousScrollHeight = element?.scrollHeight ?? 0;
      const previousScrollTop = element?.scrollTop ?? 0;
      input.setLoadingOlderSessionId(input.displayedSessionId);
      try {
        const result = await input.transport.sessionBrowser.loadOlder({
          sessionId: input.displayedSessionId,
          beforeTurnId: input.activeSessionWindow.windowStartTurnId,
          limit: 8
        });
        if (input.viewport.displayedSessionIdRef.current !== input.displayedSessionId) {
          return;
        }
        input.viewport.queuePrependScrollRestore({
          sessionId: input.displayedSessionId,
          previousScrollHeight,
          previousScrollTop
        });
        applySessionWindow(result.page, "prepend", {
          activate: false
        });
      } catch (error) {
        input.onStatusNotice({
          message: `Load earlier turns failed: ${(error as Error).message}`,
          persistent: true,
          source: "session-browser"
        });
      } finally {
        input.setLoadingOlderSessionId((current) =>
          current === input.displayedSessionId ? undefined : current
        );
      }
    },
    onCreateSession: async (workspaceId: string, agentId: string) => {
      if (!input.transport || !agentId) {
        return;
      }
      input.onStatusNotice({
        message: "Creating session…",
        persistent: true,
        source: "create-session"
      });
      let requestId: number | undefined;
      try {
        const previousSessionId = input.viewport.displayedSessionIdRef.current;
        if (previousSessionId) {
          await releaseSessionCache(previousSessionId);
        }
        input.onResetSessionSwitchState();
        const created = await input.transport.sessionBrowser.create({
          workspaceId,
          agentId,
          sessionProfile: {
            engineId: agentId
          }
        });
        requestId = ++openSessionRequestIdRef.current;
        input.setBrowserSelectedSessionId(created.sessionId);
        input.setOpeningSessionId(created.sessionId);
        await hydrateOpenedSession(created.sessionId, requestId);
        if (openSessionRequestIdRef.current !== requestId) {
          return;
        }
        await input.refreshSessionBrowser({
          mode: "workspace",
          workspaceId
        });
        input.onStatusNotice({
          message: `Created session for ${agentId}`,
          source: "create-session"
        });
      } catch (error) {
        if (requestId && openSessionRequestIdRef.current !== requestId) {
          return;
        }
        input.setOpeningSessionId(undefined);
        input.onStatusNotice({
          message: `Create session failed: ${(error as Error).message}`,
          persistent: true,
          source: "create-session"
        });
      }
    },
    onOpenSession: async (sessionId: string) => {
      if (!input.transport) {
        return;
      }
      const previousSessionId = input.viewport.displayedSessionIdRef.current;
      if (previousSessionId && previousSessionId !== sessionId) {
        await releaseSessionCache(previousSessionId);
      }
      input.onResetSessionSwitchState();
      input.setBrowserSelectedSessionId(sessionId);
      input.setOpeningSessionId(sessionId);
      const requestId = ++openSessionRequestIdRef.current;
      input.onStatusNotice({
        message: "Opening session…",
        persistent: true,
        source: "session-browser"
      });
      try {
        await hydrateOpenedSession(sessionId, requestId);
        if (openSessionRequestIdRef.current !== requestId) {
          return;
        }
        await input.refreshSessionBrowser({
          mode: "workspace",
          workspaceId: findSessionNode(input.workspaceTree, sessionId)?.workspaceId
        });
        input.onStatusNotice(undefined);
      } catch (error) {
        if (openSessionRequestIdRef.current !== requestId) {
          return;
        }
        input.setOpeningSessionId(undefined);
        input.onStatusNotice({
          message: `Open session failed: ${(error as Error).message}`,
          persistent: true,
          source: "session-browser"
        });
      }
    }
  };
};
