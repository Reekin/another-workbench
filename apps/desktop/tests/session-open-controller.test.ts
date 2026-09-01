import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DomainSnapshot, SessionWindowRpc } from "@another-workbench/shared";
import { createRendererStore } from "../src/store/store.js";
import {
  canActivateCachedSessionWindow,
  useSessionOpenController
} from "../src/ui/chat-shell/use-session-open-controller.js";
import type { TranscriptViewportController } from "../src/ui/chat-shell/use-transcript-viewport-controller.js";

type SessionOpenController = ReturnType<typeof useSessionOpenController>;
type SessionOpenControllerInput = Parameters<typeof useSessionOpenController>[0];

const snapshotForSession = (sessionId: string): DomainSnapshot => ({
  conversations: [
    {
      conversationId: `conversation-${sessionId}`,
      participantEngineIds: ["agent-codex"],
      activeSessionId: sessionId,
      sessionIds: [sessionId],
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:00.000Z"
    }
  ],
  sessions: [
    {
      sessionId,
      conversationId: `conversation-${sessionId}`,
      engineId: "agent-codex",
      status: "running",
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:00.000Z"
    }
  ],
  turns: [],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  participants: [],
  threadGoals: [],
  sessionRelations: []
});

const sessionWindowFor = (
  sessionId: string,
  cursor = `cursor-${sessionId}`
): SessionWindowRpc => ({
  sessionId,
  snapshot: snapshotForSession(sessionId),
  cursor,
  hasOlder: false,
  hasNewer: false
});

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
};

const renderController = (
  displayedSessionId: string,
  cachedSessionId?: string
): {
  controller: SessionOpenController;
  open: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  refreshSessionBrowser: ReturnType<typeof vi.fn>;
  openRequests: Map<
    string,
    Array<ReturnType<typeof deferred<{ page: SessionWindowRpc }>>>
  >;
  sessionWindows: () => Record<string, SessionWindowRpc | undefined>;
  viewportDisplayedSessionIdRef: { current: string | undefined };
} => {
  const store = createRendererStore();
  if (cachedSessionId) {
    store.hydrateSessionWindow(
      cachedSessionId,
      snapshotForSession(cachedSessionId),
      "replace",
      `cursor-${cachedSessionId}`
    );
  }
  const openRequests = new Map<
    string,
    Array<ReturnType<typeof deferred<{ page: SessionWindowRpc }>>>
  >();
  const open = vi.fn((sessionId: string) => {
    const request = deferred<{ page: SessionWindowRpc }>();
    const requests = openRequests.get(sessionId) ?? [];
    requests.push(request);
    openRequests.set(sessionId, requests);
    return request.promise;
  });
  const activate = vi.fn(async (sessionId: string) => ({ sessionId }));
  const refreshSessionBrowser = vi.fn(async () => {});
  let sessionWindows: Record<string, SessionWindowRpc | undefined> =
    cachedSessionId
      ? {
          [cachedSessionId]: sessionWindowFor(cachedSessionId)
        }
      : {};
  const viewportDisplayedSessionIdRef: { current: string | undefined } = {
    current: displayedSessionId
  };
  let controller: SessionOpenController | undefined;

  const viewport = {
    transcriptRef: { current: null },
    transcriptContentRef: { current: null },
    displayedSessionIdRef: viewportDisplayedSessionIdRef,
    setDisplayedSessionIdRef: (sessionId: string | undefined) => {
      viewportDisplayedSessionIdRef.current = sessionId;
    },
    queuePrependScrollRestore: vi.fn(),
    queueViewportTarget: vi.fn(),
    scrollToBottom: vi.fn(),
    clearPendingViewportState: vi.fn()
  } as unknown as TranscriptViewportController;

  const input: SessionOpenControllerInput = {
    store,
    transport: {
      sessionBrowser: {
        open,
        activate,
        create: vi.fn(),
        loadOlder: vi.fn()
      }
    } as unknown as SessionOpenControllerInput["transport"],
    workspaceTree: [],
    sessionWindows,
    setSessionWindows: ((updater) => {
      sessionWindows =
        typeof updater === "function" ? updater(sessionWindows) : updater;
    }) as SessionOpenControllerInput["setSessionWindows"],
    setLoadingOlderSessionId: vi.fn(),
    setBrowserSelectedSessionId: vi.fn(),
    setOpeningSessionId: vi.fn(),
    displayedSessionId,
    viewport,
    isOpeningSelectedSession: false,
    onResetSessionSwitchState: vi.fn(),
    onStatusNotice: vi.fn() as SessionOpenControllerInput["onStatusNotice"],
    refreshSessionBrowser
  };

  const Harness = (): ReturnType<typeof createElement> => {
    controller = useSessionOpenController(input);
    return createElement("div");
  };

  renderToStaticMarkup(createElement(Harness));
  if (!controller) {
    throw new Error("session open controller did not render");
  }
  return {
    controller,
    open,
    activate,
    refreshSessionBrowser,
    openRequests,
    sessionWindows: () => sessionWindows,
    viewportDisplayedSessionIdRef
  };
};

describe("useSessionOpenController background refresh", () => {
  it("does not start background refresh while a manual session open is in flight", async () => {
    const {
      controller,
      open,
      openRequests,
      sessionWindows,
      refreshSessionBrowser
    } = renderController("session-a");

    const manualOpen = controller.onOpenSession("session-b");
    await controller.refreshDisplayedSessionWindow("session-a", {
      forceProviderHydration: true
    });
    await flushMicrotasks();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("session-b", {
      forceProviderHydration: undefined
    });

    openRequests.get("session-b")?.[0]?.resolve({
      page: sessionWindowFor("session-b", "cursor-b")
    });
    await manualOpen;

    expect(sessionWindows()["session-b"]?.cursor).toBe("cursor-b");
    expect(sessionWindows()["session-a"]).toBeUndefined();
    expect(refreshSessionBrowser).not.toHaveBeenCalled();
  });

  it("opens a cached session without refreshing or resetting the browser page", async () => {
    const {
      controller,
      open,
      activate,
      refreshSessionBrowser
    } = renderController("session-a", "session-b");

    await controller.onOpenSession("session-b");

    expect(open).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith("session-b");
    expect(refreshSessionBrowser).not.toHaveBeenCalled();
  });

  it("does not let an in-flight background refresh cancel or apply over a manual switch", async () => {
    const {
      controller,
      open,
      openRequests,
      sessionWindows,
      viewportDisplayedSessionIdRef
    } = renderController("session-a");

    const backgroundRefresh = controller.refreshDisplayedSessionWindow("session-a", {
      forceProviderHydration: true
    });
    expect(open).toHaveBeenCalledWith("session-a", {
      forceProviderHydration: true
    });

    viewportDisplayedSessionIdRef.current = "session-b";
    const manualOpen = controller.onOpenSession("session-b");
    openRequests.get("session-a")?.[0]?.resolve({
      page: sessionWindowFor("session-a", "cursor-a")
    });
    await backgroundRefresh;

    expect(sessionWindows()["session-a"]).toBeUndefined();

    openRequests.get("session-b")?.[0]?.resolve({
      page: sessionWindowFor("session-b", "cursor-b")
    });
    await manualOpen;

    expect(sessionWindows()["session-b"]?.cursor).toBe("cursor-b");
  });

  it("invalidates a pending background refresh when manual navigation leaves and returns to the same session", async () => {
    const {
      controller,
      open,
      openRequests,
      sessionWindows,
      viewportDisplayedSessionIdRef
    } = renderController("session-a");

    const backgroundRefresh = controller.refreshDisplayedSessionWindow("session-a", {
      forceProviderHydration: true
    });
    expect(open).toHaveBeenCalledWith("session-a", {
      forceProviderHydration: true
    });

    viewportDisplayedSessionIdRef.current = "session-b";
    const openSessionB = controller.onOpenSession("session-b");
    openRequests.get("session-b")?.[0]?.resolve({
      page: sessionWindowFor("session-b", "cursor-b")
    });
    await openSessionB;
    expect(sessionWindows()["session-b"]?.cursor).toBe("cursor-b");

    viewportDisplayedSessionIdRef.current = "session-a";
    const openSessionA = controller.onOpenSession("session-a");
    openRequests.get("session-a")?.[1]?.resolve({
      page: sessionWindowFor("session-a", "cursor-a-manual")
    });
    await openSessionA;
    expect(sessionWindows()["session-a"]?.cursor).toBe("cursor-a-manual");

    openRequests.get("session-a")?.[0]?.resolve({
      page: sessionWindowFor("session-a", "cursor-a-background")
    });
    await backgroundRefresh;

    expect(sessionWindows()["session-a"]?.cursor).toBe("cursor-a-manual");
  });
});

describe("canActivateCachedSessionWindow", () => {
  it("rejects an empty cached provider window without projected turns", () => {
    expect(
      canActivateCachedSessionWindow({
        window: sessionWindowFor("session-child"),
        session: {
          ...snapshotForSession("session-child").sessions[0]!,
          lastTurnId: "turn-index-only",
          metadata: {
            providerKind: "codex-thread",
            providerSessionId: "thread-child"
          }
        }
      })
    ).toBe(false);
  });

  it("routes provider windows through authoritative open while keeping local caches fast", () => {
    const providerWindow = {
      ...sessionWindowFor("session-child"),
      windowStartTurnId: "turn-1",
      windowEndTurnId: "turn-1"
    };
    const providerSession = {
      ...snapshotForSession("session-child").sessions[0]!,
      metadata: {
        providerKind: "codex-thread",
        providerSessionId: "thread-child"
      }
    };

    expect(
      canActivateCachedSessionWindow({
        window: providerWindow,
        session: providerSession
      })
    ).toBe(false);
    expect(
      canActivateCachedSessionWindow({
        window: sessionWindowFor("session-local"),
        session: snapshotForSession("session-local").sessions[0]
      })
    ).toBe(true);
  });
});
