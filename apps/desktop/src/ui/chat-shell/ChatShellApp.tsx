import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentDescriptor,
  ChatTreeSnapshotRpc,
  SessionActionDescriptorRpc,
  SessionWindowRpc,
  WorkspaceRecordRpc,
  WorkspaceBrowserNodeRpc
} from "@another-workbench/shared";
import "xterm/css/xterm.css";
import {
  selectParticipantsForConversation,
  selectTurnsForSession
} from "../../store/selectors.js";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { connectDesktopTransportToStore } from "../../transport/store-bridge.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";
import { ChatTreePanel } from "./ChatTreePanel.js";
import { TurnProcessPanel } from "./TurnProcessPanel.js";
import { buildParticipantDirectory } from "./participant-directory.js";
import {
  resolveComposerStatus,
  type ComposerStatusNotice
} from "./composer-status.js";
import { filterTranscriptRowsForChatTree } from "./chat-tree-transcript.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import { useRendererStoreState } from "./use-renderer-store-state.js";
import { prioritizeWorkspaceIdsForReconciliation } from "./workspace-reconciliation.js";
import "./chat-shell.css";

type SessionMenuState = {
  sessionId: string;
  x: number;
  y: number;
  actions: SessionActionDescriptorRpc[];
};

const resolveSessionMenuViewportStyle = (
  sessionMenu: SessionMenuState
): CSSProperties => {
  const estimatedWidth = 188;
  const estimatedHeight = sessionMenu.actions.length * 37 + 8;
  const gutter = 8;
  if (typeof window === "undefined") {
    return {
      left: sessionMenu.x,
      top: sessionMenu.y
    };
  }
  const maxLeft = Math.max(gutter, window.innerWidth - estimatedWidth - gutter);
  const maxTop = Math.max(gutter, window.innerHeight - estimatedHeight - gutter);
  return {
    left: Math.min(sessionMenu.x, maxLeft),
    top: Math.min(sessionMenu.y, maxTop)
  };
};

export type ChatShellAppProps = {
  store: RendererStore;
  transport?: DesktopTransport;
  title?: string;
};

const uniqueByAgentId = (
  descriptors: Array<AgentDescriptor | undefined>
): AgentDescriptor[] => {
  const seen = new Set<string>();
  const result: AgentDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor || seen.has(descriptor.agentId)) {
      continue;
    }
    seen.add(descriptor.agentId);
    result.push(descriptor);
  }
  return result;
};

const formatTimestamp = (iso: string | undefined): string => {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
};

const buildWorkspaceAgentFallbacks = (
  workspaces: WorkspaceBrowserNodeRpc[]
): AgentDescriptor[] => {
  const agentIds = new Set<string>();
  for (const workspace of workspaces) {
    const stack = [...workspace.sessions];
    while (stack.length > 0) {
      const session = stack.pop();
      if (!session || agentIds.has(session.agentId)) {
        continue;
      }
      agentIds.add(session.agentId);
      stack.push(...session.children);
    }
  }

  return [...agentIds].map((agentId) => ({
    agentId,
    displayName: agentId,
    capabilities: []
  }));
};

const mergeWorkspaceBrowserTree = (
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

const findSessionNode = (
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

const findActiveSessionNode = (
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

const resolveStatusDotLabel = (
  statusDot: WorkspaceBrowserNodeRpc["sessions"][number]["statusDot"]
): string | undefined => {
  switch (statusDot) {
    case "running":
      return "running";
    case "unread_completed":
      return "unread";
    default:
      return undefined;
  }
};

const sessionActionLabel = (action: SessionActionDescriptorRpc): string => action.label;

export const ChatShellApp = ({
  store,
  transport,
  title = "Another Workbench"
}: ChatShellAppProps): ReactElement => {
  const state = useRendererStoreState(store);
  const [availableAgents, setAvailableAgents] = useState<AgentDescriptor[]>([]);
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceBrowserNodeRpc[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [statusNotice, setStatusNotice] = useState<ComposerStatusNotice | undefined>();
  const [chatTree, setChatTree] = useState<ChatTreeSnapshotRpc | undefined>();
  const [chatTreeLoading, setChatTreeLoading] = useState(false);
  const [chatTreeError, setChatTreeError] = useState<string | undefined>();
  const [sessionWindows, setSessionWindows] = useState<
    Record<string, SessionWindowRpc | undefined>
  >({});
  const [loadingOlderSessionId, setLoadingOlderSessionId] = useState<
    string | undefined
  >();
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | undefined>();
  const [browserSelectedSessionId, setBrowserSelectedSessionId] = useState<
    string | undefined
  >();
  const [openingSessionId, setOpeningSessionId] = useState<string | undefined>();
  const [inspectedTurnId, setInspectedTurnId] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraftAgentId, setSettingsDraftAgentId] = useState("");
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const reconcileQueueRef = useRef<string[]>([]);
  const reconcileQueuedIdsRef = useRef(new Set<string>());
  const reconcileAttemptedIdsRef = useRef(new Set<string>());
  const reconcileRunningRef = useRef(false);
  const mountedRef = useRef(true);
  const openingSessionIdRef = useRef<string | undefined>(undefined);
  const openSessionRequestIdRef = useRef(0);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const displayedSessionIdRef = useRef<string | undefined>(undefined);
  const pendingPrependScrollRef = useRef<
    | {
        sessionId: string;
        previousScrollHeight: number;
        previousScrollTop: number;
      }
    | undefined
  >(undefined);
  const pendingViewportTargetRef = useRef<
    | {
        sessionId: string;
        type: "bottom" | "turn";
        turnId?: string;
      }
    | undefined
  >(undefined);

  const activeWorkspace = workspaceTree.find((workspace) => workspace.isActive);
  const activeSessionNode =
    findActiveSessionNode(workspaceTree) ??
    (state.activeSessionId
      ? findSessionNode(workspaceTree, state.activeSessionId)
      : undefined);
  const activeSessionId = state.activeSessionId ?? activeSessionNode?.sessionId;
  const displayedSessionId =
    openingSessionId ?? browserSelectedSessionId ?? activeSessionId;
  const displayedSessionNode = displayedSessionId
    ? findSessionNode(workspaceTree, displayedSessionId)
    : activeSessionNode;
  const displayedSession = displayedSessionId
    ? state.entities.sessions[displayedSessionId]
    : undefined;
  const activeSession = activeSessionId
    ? state.entities.sessions[activeSessionId]
    : undefined;
  const displayedConversationId =
    displayedSession?.conversationId ?? displayedSessionNode?.conversationId;
  const highlightedSessionId = displayedSessionId;
  const isOpeningSelectedSession =
    Boolean(openingSessionId) && openingSessionId === displayedSessionId;
  const activeSessionWindow =
    displayedSessionId ? sessionWindows[displayedSessionId] : undefined;
  const loadingOlderTurns = loadingOlderSessionId === displayedSessionId;
  const activeChatTree =
    chatTree?.sessionId === displayedSessionId ? chatTree : undefined;
  const browsedSessionId =
    displayedSessionId && !isOpeningSelectedSession ? displayedSessionId : undefined;
  const activeConversation =
    (displayedConversationId
      ? state.entities.conversations[
          displayedConversationId
        ]
      : undefined) ??
    (displayedSession?.conversationId
      ? state.entities.conversations[displayedSession.conversationId]
      : undefined) ??
    (state.activeConversationId
      ? state.entities.conversations[state.activeConversationId]
      : undefined);
  const turns = displayedSessionId
    ? selectTurnsForSession(state, displayedSessionId)
    : [];
  const participants = activeConversation
    ? selectParticipantsForConversation(state, activeConversation.conversationId)
    : [];
  const participantDirectory = useMemo(
    () => buildParticipantDirectory(participants),
    [participants]
  );
  const transcriptRows = useMemo(
    () => buildTurnTranscriptRows(state, turns, participantDirectory),
    [state, turns, participantDirectory]
  );
  const visibleTranscriptRows = useMemo(
    () => filterTranscriptRowsForChatTree(transcriptRows, activeChatTree),
    [transcriptRows, activeChatTree]
  );
  const renderedTranscriptRows = isOpeningSelectedSession ? [] : visibleTranscriptRows;
  const inspectedRow = useMemo(() => {
    const assistantRows = renderedTranscriptRows.filter(
      (row) => row.messageRole !== "user"
    );
    if (assistantRows.length === 0) {
      return undefined;
    }
    if (inspectedTurnId) {
      return (
        assistantRows.find((row) => row.turn.turnId === inspectedTurnId) ??
        assistantRows[assistantRows.length - 1]
      );
    }
    return assistantRows[assistantRows.length - 1];
  }, [renderedTranscriptRows, inspectedTurnId]);

  const fallbackAgents = useMemo(
    () => buildWorkspaceAgentFallbacks(workspaceTree),
    [workspaceTree]
  );
  const agents = useMemo(
    () => uniqueByAgentId([...availableAgents, ...fallbackAgents]),
    [availableAgents, fallbackAgents]
  );

  const status = resolveComposerStatus({
    transportAvailable: Boolean(transport),
    selectedAgentId,
    activeSession:
      activeSession ??
      (activeSessionId
        ? ({
            sessionId: activeSessionId,
            conversationId: displayedConversationId ?? "",
            agentId: displayedSessionNode?.agentId ?? selectedAgentId,
            status: "idle",
            createdAt: "",
            updatedAt: ""
          } as NonNullable<typeof activeSession>)
        : undefined),
    approvals: renderedTranscriptRows.at(-1)?.approvals ?? [],
    notice: statusNotice
  });

  const activateLoadedSession = (sessionId: string): boolean => {
    const session = store.getState().entities.sessions[sessionId];
    if (!session) {
      return false;
    }
    store.dispatch({
      type: "store/setActiveConversation",
      conversationId: session.conversationId
    });
    store.dispatch({
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
    store.disposeSession(sessionId);
    setSessionWindows((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    if (chatTree?.sessionId === sessionId) {
      setChatTree(undefined);
    }
    setChatTreeError(undefined);
    pendingPrependScrollRef.current = undefined;
    pendingViewportTargetRef.current = undefined;
  };

  const resetSessionSwitchState = (): void => {
    setLoadingOlderSessionId(undefined);
    setChatTreeError(undefined);
    setInspectedTurnId(undefined);
  };

  const applySessionWindow = (
    page: SessionWindowRpc,
    mode: "replace" | "prepend" = "replace",
    options: {
      activate?: boolean;
    } = {}
  ): void => {
    store.hydrateSessionWindow(page.sessionId, page.snapshot, mode);
    setSessionWindows((current) => {
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
      setInspectedTurnId(page.windowEndTurnId);
      pendingViewportTargetRef.current = {
        sessionId: page.sessionId,
        type: page.windowEndTurnId && page.hasNewer ? "turn" : "bottom",
        turnId: page.windowEndTurnId && page.hasNewer ? page.windowEndTurnId : undefined
      };
    }
    if (options.activate ?? true) {
      activateLoadedSession(page.sessionId);
    }
  };

  const hydrateOpenedSession = async (
    sessionId: string,
    requestId: number
  ): Promise<void> => {
    if (!transport) {
      return;
    }
    const result = await transport.sessionBrowser.open(sessionId);
    if (openSessionRequestIdRef.current !== requestId) {
      return;
    }
    applySessionWindow(result.page, "replace");
  };

  const onLoadOlder = async (): Promise<void> => {
    if (
      !transport ||
      !displayedSessionId ||
      !activeSessionWindow?.hasOlder ||
      !activeSessionWindow.windowStartTurnId ||
      loadingOlderSessionId === displayedSessionId ||
      isOpeningSelectedSession
    ) {
      return;
    }

    const element = transcriptRef.current;
    const previousScrollHeight = element?.scrollHeight ?? 0;
    const previousScrollTop = element?.scrollTop ?? 0;
    setLoadingOlderSessionId(displayedSessionId);
    try {
      const result = await transport.sessionBrowser.loadOlder({
        sessionId: displayedSessionId,
        beforeTurnId: activeSessionWindow.windowStartTurnId,
        limit: 8
      });
      if (displayedSessionIdRef.current !== displayedSessionId) {
        return;
      }
      pendingPrependScrollRef.current = {
        sessionId: displayedSessionId,
        previousScrollHeight,
        previousScrollTop
      };
      applySessionWindow(result.page, "prepend", {
        activate: false
      });
    } catch (error) {
      setStatusNotice({
        message: `Load earlier turns failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-browser"
      });
    } finally {
      setLoadingOlderSessionId((current) =>
        current === displayedSessionId ? undefined : current
      );
    }
  };

  const refreshSessionBrowser = async (input?: {
    mode?: "all" | "visible" | "workspace";
    workspaceId?: string;
  }): Promise<void> => {
    if (!transport) {
      setWorkspaceTree([]);
      return;
    }
    const workspaceState = await transport.workspace.list();
    const visibleWorkspaceIds = new Set(
      workspaceTree
        .filter((workspace) => workspace.isExpanded || workspace.isActive)
        .map((workspace) => workspace.workspaceId)
    );
    if (workspaceState.lastActiveWorkspaceId) {
      visibleWorkspaceIds.add(workspaceState.lastActiveWorkspaceId);
    }

    const mode = input?.mode ?? "visible";
    const workspaceIdsToLoad =
      mode === "all"
        ? workspaceState.workspaces.map((workspace) => workspace.workspaceId)
        : mode === "workspace" && input?.workspaceId
          ? [input.workspaceId]
          : [...visibleWorkspaceIds];

    const loadedWorkspaces = await Promise.all(
      workspaceIdsToLoad.map(async (workspaceId) => {
        const tree = await transport.sessionBrowser.listTree(workspaceId);
        return tree.workspaces[0];
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
    if (!transport || reconcileRunningRef.current) {
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
          await transport.sessionBrowser.reconcile(workspaceId);
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
          setStatusNotice({
            message: `Background session sync failed: ${(error as Error).message}`,
            source: "session-browser"
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
    openingSessionIdRef.current = openingSessionId;
  }, [openingSessionId]);

  useEffect(() => {
    displayedSessionIdRef.current = displayedSessionId;
  }, [displayedSessionId]);

  useEffect(() => {
    if (!openingSessionId) {
      return;
    }
    if (!sessionWindows[openingSessionId]) {
      return;
    }
    setOpeningSessionId((current) =>
      current === openingSessionId ? undefined : current
    );
    setStatusNotice((current) =>
      current?.source === "session-browser" ? undefined : current
    );
  }, [openingSessionId, sessionWindows]);

  useEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const element = transcriptRef.current;
    if (
      !pending ||
      !element ||
      displayedSessionId !== pending.sessionId ||
      isOpeningSelectedSession
    ) {
      return;
    }
    pendingPrependScrollRef.current = undefined;
    const animationFrameId = window.requestAnimationFrame(() => {
      element.scrollTop =
        element.scrollHeight -
        pending.previousScrollHeight +
        pending.previousScrollTop;
    });
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [displayedSessionId, isOpeningSelectedSession, activeSessionWindow?.windowStartTurnId]);

  useEffect(() => {
    const pendingTarget = pendingViewportTargetRef.current;
    const element = transcriptRef.current;
    if (
      !pendingTarget ||
      !element ||
      displayedSessionId !== pendingTarget.sessionId ||
      isOpeningSelectedSession
    ) {
      return;
    }

    pendingViewportTargetRef.current = undefined;
    const animationFrameId = window.requestAnimationFrame(() => {
      if (pendingTarget.type === "turn" && pendingTarget.turnId) {
        const targetRow = element.querySelector<HTMLElement>(
          `[data-turn-id="${pendingTarget.turnId}"]`
        );
        if (targetRow) {
          targetRow.scrollIntoView({
            block: "start"
          });
          return;
        }
      }
      element.scrollTop = element.scrollHeight;
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    displayedSessionId,
    isOpeningSelectedSession,
    activeSessionWindow?.windowEndTurnId,
    renderedTranscriptRows.length
  ]);

  useEffect(() => {
    reconcileQueueRef.current = [];
    reconcileQueuedIdsRef.current = new Set();
    reconcileAttemptedIdsRef.current = new Set();
    reconcileRunningRef.current = false;
  }, [transport]);

  useEffect(() => {
    if (!statusNotice || statusNotice.persistent) {
      return;
    }
    const timeoutId = setTimeout(() => {
      setStatusNotice((current) => (current === statusNotice ? undefined : current));
    }, 2_000);
    return () => clearTimeout(timeoutId);
  }, [statusNotice]);

  useEffect(() => {
    if (!transport) {
      return;
    }
    void refreshSessionBrowser({
      mode: "visible"
    }).catch((error) => {
      setStatusNotice({
        message: `Session browser failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-browser"
      });
    });
  }, [transport, state.eventStream.lastCursor]);

  useEffect(() => {
    if (!transport || reconcileQueueRef.current.length === 0 || openingSessionId) {
      return;
    }
    void runBackgroundReconciliation();
  }, [transport, workspaceTree, openingSessionId]);

  useEffect(() => {
    const handleWindowClick = () => setSessionMenu(undefined);
    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, []);

  useEffect(() => {
    if (!transport) {
      return;
    }
    let disposed = false;
    void transport.agent
      .list()
      .then((list) => {
        if (!disposed) {
          setAvailableAgents(list);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Agent list failed: ${(error as Error).message}`,
            persistent: true,
            source: "agent-list"
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport]);

  useEffect(() => {
    if (settingsHydrated && !selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0]!.agentId);
    }
  }, [agents, selectedAgentId, settingsHydrated]);

  useEffect(() => {
    if (!transport) {
      setSettingsHydrated(true);
      return;
    }
    let disposed = false;
    void transport.settings
      .get()
      .then((settings) => {
        if (disposed) {
          return;
        }
        if (settings.defaultNewSessionAgentId) {
          setSelectedAgentId(settings.defaultNewSessionAgentId);
          setSettingsDraftAgentId(settings.defaultNewSessionAgentId);
        }
        setSettingsHydrated(true);
      })
      .catch((error) => {
        if (!disposed) {
          setSettingsHydrated(true);
          setStatusNotice({
            message: `Settings load failed: ${(error as Error).message}`,
            persistent: true,
            source: "settings"
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport]);

  useEffect(() => {
    if (!transport || !selectedAgentId) {
      return;
    }
    let disposed = false;
    void transport.agent
      .select({ agentId: selectedAgentId })
      .then(() => {
        if (!disposed) {
          setStatusNotice(undefined);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Agent select failed: ${(error as Error).message}`,
            persistent: true,
            source: "agent-select"
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport, selectedAgentId]);

  useEffect(() => {
    if (!transport) {
      return;
    }
    let unsubscribe: (() => Promise<void>) | undefined;
    let disposed = false;
    void connectDesktopTransportToStore({
      transport,
      store
    })
      .then((binding) => {
        if (disposed) {
          void binding.unsubscribe();
          return;
        }
        unsubscribe = binding.unsubscribe;
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Event subscribe failed: ${(error as Error).message}`,
            persistent: true,
            source: "subscription"
          });
        }
      });
    return () => {
      disposed = true;
      if (unsubscribe) {
        void unsubscribe();
      }
    };
  }, [transport, store]);

  useEffect(() => {
    if (!transport || !browsedSessionId) {
      setChatTree(undefined);
      setChatTreeError(undefined);
      setChatTreeLoading(false);
      return;
    }
    let disposed = false;
    setChatTreeLoading(true);
    setChatTreeError(undefined);
    void transport.chatTree
      .get(browsedSessionId)
      .then((nextTree) => {
        if (!disposed) {
          if (displayedSessionIdRef.current === browsedSessionId) {
            setChatTree(nextTree);
          }
          setChatTreeError(undefined);
        }
      })
      .catch((error) => {
        if (!disposed) {
          if (displayedSessionIdRef.current === browsedSessionId) {
            setChatTreeError(undefined);
            setStatusNotice({
              message: `Chat tree refresh failed: ${(error as Error).message}`,
              source: "chat-tree"
            });
          }
        }
      })
      .finally(() => {
        if (!disposed) {
          setChatTreeLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport, browsedSessionId, state.eventStream.lastCursor]);

  const onSend = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !activeSessionId || !transport) {
      return;
    }
    setStatusNotice({
      message: "Sending…",
      persistent: true,
      source: "send"
    });
    try {
      await transport.chat.send({
        sessionId: activeSessionId,
        content: text
      });
      setDraft("");
      setStatusNotice({
        message: "Message sent.",
        source: "send"
      });
    } catch (error) {
      setStatusNotice({
        message: `Send failed: ${(error as Error).message}`,
        persistent: true,
        source: "send"
      });
    }
  };

  const onAddWorkspace = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    try {
      const picked = await transport.workspace.pickDirectory();
      if (picked.canceled || !picked.rootPath) {
        return;
      }
      const rootPath = picked.rootPath;
      const workspace = await transport.workspace.add({
        rootPath
      });
      await transport.sessionBrowser.reconcile(workspace.workspaceId);
      await refreshSessionBrowser({
        mode: "all"
      });
      setStatusNotice({
        message: `Added workspace ${rootPath}`,
        source: "workspace-add"
      });
    } catch (error) {
      setStatusNotice({
        message: `Add workspace failed: ${(error as Error).message}`,
        persistent: true,
        source: "workspace-add"
      });
    }
  };

  const onOpenSettings = (): void => {
    setSettingsDraftAgentId(selectedAgentId);
    setSettingsOpen(true);
  };

  const onSaveSettings = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    setSettingsSaving(true);
    try {
      const result = await transport.settings.update({
        defaultNewSessionAgentId: settingsDraftAgentId || undefined
      });
      setSelectedAgentId(result.defaultNewSessionAgentId ?? "");
      setSettingsOpen(false);
      setStatusNotice({
        message: result.defaultNewSessionAgentId
          ? `Default agent set to ${result.defaultNewSessionAgentId}`
          : "Default agent cleared.",
        source: "settings"
      });
    } catch (error) {
      setStatusNotice({
        message: `Settings save failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings"
      });
    } finally {
      setSettingsSaving(false);
    }
  };

  const onToggleWorkspace = async (workspaceId: string): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.workspace.select(workspaceId);
    await transport.workspace.toggleExpanded(workspaceId);
    await refreshSessionBrowser({
      mode: "workspace",
      workspaceId
    });
  };

  const onCreateSession = async (workspaceId: string): Promise<void> => {
    if (!transport || !selectedAgentId) {
      return;
    }
    setStatusNotice({
      message: "Creating session…",
      persistent: true,
      source: "create-session"
    });
    let requestId: number | undefined;
    try {
      const previousSessionId = displayedSessionIdRef.current;
      if (previousSessionId) {
        await releaseSessionCache(previousSessionId);
      }
      resetSessionSwitchState();
      const created = await transport.sessionBrowser.create({
        workspaceId,
        agentId: selectedAgentId
      });
      requestId = ++openSessionRequestIdRef.current;
      setBrowserSelectedSessionId(created.sessionId);
      setOpeningSessionId(created.sessionId);
      await hydrateOpenedSession(created.sessionId, requestId);
      if (openSessionRequestIdRef.current !== requestId) {
        return;
      }
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId
      });
      setStatusNotice({
        message: `Created session for ${selectedAgentId}`,
        source: "create-session"
      });
    } catch (error) {
      if (requestId && openSessionRequestIdRef.current !== requestId) {
        return;
      }
      setOpeningSessionId(undefined);
      setStatusNotice({
        message: `Create session failed: ${(error as Error).message}`,
        persistent: true,
        source: "create-session"
      });
    }
  };

  const onOpenSession = async (sessionId: string): Promise<void> => {
    if (!transport) {
      return;
    }
    const previousSessionId = displayedSessionIdRef.current;
    if (previousSessionId && previousSessionId !== sessionId) {
      await releaseSessionCache(previousSessionId);
    }
    resetSessionSwitchState();
    setBrowserSelectedSessionId(sessionId);
    setOpeningSessionId(sessionId);
    const requestId = ++openSessionRequestIdRef.current;
    setStatusNotice({
      message: "Opening session…",
      persistent: true,
      source: "session-browser"
    });
    try {
      await hydrateOpenedSession(sessionId, requestId);
      if (openSessionRequestIdRef.current !== requestId) {
        return;
      }
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId: findSessionNode(workspaceTree, sessionId)?.workspaceId
      });
      setStatusNotice(undefined);
    } catch (error) {
      if (openSessionRequestIdRef.current !== requestId) {
        return;
      }
      setOpeningSessionId(undefined);
      setStatusNotice({
        message: `Open session failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-browser"
      });
    }
  };

  const onToggleSessionTree = async (sessionId: string): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.sessionBrowser.toggleExpanded(sessionId);
    await refreshSessionBrowser({
      mode: "workspace",
      workspaceId: findSessionNode(workspaceTree, sessionId)?.workspaceId
    });
  };

  const onOpenSessionMenu = async (
    event: ReactMouseEvent,
    sessionId: string
  ): Promise<void> => {
    if (!transport) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const result = await transport.sessionBrowser.getActions(sessionId);
    setSessionMenu({
      sessionId,
      x: event.clientX,
      y: event.clientY,
      actions: result.actions
    });
  };

  const onRunSessionAction = async (
    sessionId: string,
    action: SessionActionDescriptorRpc["action"]
  ): Promise<void> => {
    if (!transport) {
      return;
    }
    try {
      const result = await transport.sessionBrowser.runAction({
        sessionId,
        action
      });
      setSessionMenu(undefined);
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId: findSessionNode(workspaceTree, sessionId)?.workspaceId
      });
      if (result.action === "copy_session_id") {
        await navigator.clipboard?.writeText(result.copiedText);
        setStatusNotice({
          message: `Copied ${result.copiedText}`,
          source: "session-action"
        });
        return;
      }
      if (result.action === "open_rollout") {
        window.open(result.rolloutFileUrl, "_blank", "noopener,noreferrer");
        setStatusNotice({
          message: `Opened rollout ${result.rolloutDisplayPath}`,
          source: "session-action"
        });
        return;
      }
      setStatusNotice({
        message: `${action} completed.`,
        source: "session-action"
      });
    } catch (error) {
      setStatusNotice({
        message: `${action} failed: ${(error as Error).message}`,
        persistent: true,
        source: "session-action"
      });
    }
  };

  const onRespondApproval = async (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
  }): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.approval.respond(input);
  };

  const onJumpChatTree = async (nodeId: string): Promise<void> => {
    if (!transport || !displayedSessionId || isOpeningSelectedSession) {
      return;
    }
    try {
      await transport.chatTree.jump({
        sessionId: displayedSessionId,
        nodeId
      });
      const nextTree = await transport.chatTree.get(displayedSessionId);
      setChatTree(nextTree);
      setChatTreeError(undefined);
      const currentNode =
        nextTree.nodes.find((node) => node.nodeId === nextTree.currentNodeId) ??
        nextTree.nodes.find((node) => node.nodeId === nodeId);
      if (currentNode?.turnId) {
        const requestId = ++openSessionRequestIdRef.current;
        setInspectedTurnId(currentNode.turnId);
        const result = await transport.sessionBrowser.open(displayedSessionId);
        if (openSessionRequestIdRef.current === requestId) {
          applySessionWindow(result.page, "replace");
        }
      }
      setStatusNotice({
        message: `Jumped to ${nodeId}`,
        source: "chat-tree"
      });
    } catch (error) {
      setChatTreeError(undefined);
      setStatusNotice({
        message: `Chat tree jump failed: ${(error as Error).message}`,
        persistent: true,
        source: "chat-tree"
      });
    }
  };

  const renderSessionNode = (
    session: WorkspaceBrowserNodeRpc["sessions"][number],
    depth = 0
  ): ReactElement => {
    const statusDot = resolveStatusDotLabel(session.statusDot);
    return (
      <li key={session.sessionId} className="awb-tree__item">
        <div
          className={`awb-tree__session ${
            session.isActive || session.sessionId === highlightedSessionId
              ? "is-active"
              : ""
          }`}
          style={{ "--awb-tree-depth": `${depth}` } as CSSProperties}
          onClick={() => void onOpenSession(session.sessionId)}
          onContextMenu={(event) => void onOpenSessionMenu(event, session.sessionId)}
        >
          <div className="awb-tree__session-main">
            {session.children.length > 0 ? (
              <button
                type="button"
                className="awb-tree__disclosure"
                onClick={(event) => {
                  event.stopPropagation();
                  void onToggleSessionTree(session.sessionId);
                }}
              >
                {session.isExpanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="awb-tree__indent" />
            )}
            {statusDot ? <span className={`awb-tree__dot is-${statusDot}`} /> : <span className="awb-tree__dot-placeholder" />}
            <div className="awb-tree__labels">
              <strong>{session.title}</strong>
              <span>
                {session.agentId} · {session.displaySessionId}
              </span>
            </div>
          </div>
        </div>
        {session.isExpanded && session.children.length > 0 && (
          <ul className="awb-tree__branch">
            {session.children.map((child: WorkspaceBrowserNodeRpc["sessions"][number]) =>
              renderSessionNode(child, depth + 1)
            )}
          </ul>
        )}
      </li>
    );
  };

  const sessionMenuMarkup = sessionMenu ? (
    <div
      className="awb-session-menu"
      style={resolveSessionMenuViewportStyle(sessionMenu)}
      onClick={(event) => event.stopPropagation()}
    >
      {sessionMenu.actions.map((action) => (
        <button
          key={action.action}
          type="button"
          disabled={action.disabled}
          title={action.reason}
          onClick={() => void onRunSessionAction(sessionMenu.sessionId, action.action)}
        >
          {sessionActionLabel(action)}
        </button>
      ))}
    </div>
  ) : null;

  const settingsModalMarkup = settingsOpen ? (
    <div
      className="awb-modal-scrim"
      role="presentation"
      onClick={() => setSettingsOpen(false)}
    >
      <section
        className="awb-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="awb-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="awb-modal__header">
          <div>
            <span className="awb-detail__eyebrow">Settings</span>
            <h2 id="awb-settings-title">Preferences</h2>
          </div>
          <button
            type="button"
            className="awb-ghost-button"
            onClick={() => setSettingsOpen(false)}
          >
            Close
          </button>
        </header>
        <div className="awb-modal__body">
          <label className="awb-field">
            <span>New session agent</span>
            <select
              value={settingsDraftAgentId}
              onChange={(event) => setSettingsDraftAgentId(event.target.value)}
            >
              <option value="">Follow first available agent</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <footer className="awb-modal__footer">
          <button
            type="button"
            className="awb-ghost-button"
            onClick={() => setSettingsOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="awb-secondary-button"
            onClick={() => void onSaveSettings()}
            disabled={settingsSaving}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  ) : null;

  return (
    <>
      <div className="awb-shell">
        <aside className="awb-shell__sidebar">
          <header className="awb-sidebar__header">
            <span className="awb-sidebar__eyebrow">Another Workbench</span>
            <h1>{title}</h1>
          </header>

          <section className="awb-sidebar__section awb-sidebar__section--grow">
            <div className="awb-sidebar__section-header">
              <h2>Workspaces</h2>
              <button
                type="button"
                className="awb-secondary-button"
                onClick={() => void onAddWorkspace()}
              >
                Add workspace
              </button>
            </div>

            <div className="awb-workspace-tree">
              {workspaceTree.length === 0 && (
                <p className="awb-list__empty">No workspace yet</p>
              )}
              {workspaceTree.map((workspace) => (
                <section key={workspace.workspaceId} className="awb-workspace">
                  <header
                    className={`awb-workspace__header ${workspace.isActive ? "is-active" : ""}`}
                    onClick={() => void onToggleWorkspace(workspace.workspaceId)}
                  >
                    <div>
                      <strong>{workspace.label}</strong>
                      <span>{workspace.rootPath}</span>
                    </div>
                    <button
                      type="button"
                      className="awb-workspace__add"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onCreateSession(workspace.workspaceId);
                      }}
                      title="Create session in workspace"
                    >
                      +
                    </button>
                  </header>
                  {workspace.isExpanded && (
                    <ul className="awb-tree__branch awb-tree__branch--workspace">
                      {workspace.sessions.map((session) => renderSessionNode(session))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </section>

          <footer className="awb-sidebar__footer">
            <button
              type="button"
              className="awb-sidebar__settings"
              onClick={onOpenSettings}
              aria-label="Open settings"
              title="Settings"
            >
              <span aria-hidden="true">⚙</span>
            </button>
          </footer>
        </aside>

        <main className="awb-shell__main">
          <header className="awb-main__header">
            <div>
              <span className="awb-main__eyebrow">Thread</span>
              <h2>{displayedSessionNode?.title ?? "Thread"}</h2>
              <p>
                {displayedSessionId
                  ? `${displayedSessionNode?.displaySessionId ?? displayedSessionId} · ${turns.length} turn(s)`
                  : "Open a session from the workspace tree"}
              </p>
            </div>
          </header>

          <div className="awb-main__body">
            <section className="awb-transcript" ref={transcriptRef}>
              {renderedTranscriptRows.length === 0 && (
                <div className="awb-transcript__empty">
                  {isOpeningSelectedSession && <div className="awb-loading-spinner" aria-hidden="true" />}
                  <h3>
                    {isOpeningSelectedSession
                      ? "Loading thread"
                      : activeSessionId
                        ? "Empty thread"
                        : "No thread selected"}
                  </h3>
                  <p>
                    {isOpeningSelectedSession
                      ? "Loading conversation history for the selected session."
                      : activeSessionId
                        ? "Send a message to start the next turn in this session."
                        : "Open an existing session or create a new one from the workspace pane."}
                  </p>
                </div>
              )}

              {activeSessionWindow?.hasOlder && renderedTranscriptRows.length > 0 && (
                <div className="awb-transcript__load-earlier">
                  <button
                    type="button"
                    className="awb-transcript__load-earlier-button"
                    onClick={() => void onLoadOlder()}
                    disabled={loadingOlderTurns || isOpeningSelectedSession}
                  >
                    {loadingOlderTurns ? "Loading earlier…" : "Load earlier"}
                  </button>
                </div>
              )}

              {renderedTranscriptRows.map((row) => {
                const isUserTurn = row.messageRole === "user";
                const isInspected =
                  !isUserTurn && inspectedRow?.turn.turnId === row.turn.turnId;
                return (
                  <article
                    key={row.rowId}
                    data-turn-id={row.turn.turnId}
                    className={`awb-chat-entry ${isUserTurn ? "is-user" : "is-assistant"}${isInspected ? " is-inspected" : ""}`}
                    onClick={() => {
                      if (!isUserTurn) {
                        setInspectedTurnId(row.turn.turnId);
                      }
                    }}
                  >
                    <div className="awb-chat-entry__messages">
                      {row.blocks.length === 0 && (
                        <p className="awb-turn__empty">
                          {isUserTurn ? "No message content." : "Waiting for response…"}
                        </p>
                      )}
                      {row.blocks.map((block) => (
                        <MessageMarkdownView
                          key={block.blockId}
                          block={block}
                          participantDirectory={participantDirectory}
                        />
                      ))}
                    </div>
                    <footer className="awb-chat-entry__meta">
                      <span>{formatTimestamp(row.turn.completedAt ?? row.turn.startedAt)}</span>
                    </footer>
                  </article>
                );
              })}
            </section>
          </div>

          <footer className="awb-composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the active session..."
              disabled={isOpeningSelectedSession}
            />
            <div className="awb-composer__actions">
              <span className="awb-status">{status}</span>
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={isOpeningSelectedSession}
              >
                Send
              </button>
            </div>
          </footer>
        </main>

        <aside className="awb-shell__detail">
          <header className="awb-detail__header">
            <div>
              <span className="awb-detail__eyebrow">Inspector</span>
              <h2>Inspector</h2>
            </div>
          </header>

          <section className="awb-detail__body">
            <div className="awb-inspector">
              <section className="awb-inspector__section">
                <header className="awb-inspector__section-header">
                  <span>Turn process</span>
                  <strong>{inspectedRow?.turn.turnId ?? "No turn selected"}</strong>
                </header>
                {inspectedRow ? (
                  inspectedRow.hasProcessDetails ? (
                    <TurnProcessPanel
                      row={inspectedRow}
                      participantDirectory={participantDirectory}
                      onRespondApproval={transport ? onRespondApproval : undefined}
                    />
                  ) : (
                    <p className="awb-detail__empty">
                      This turn has no tool, terminal, or approval activity.
                    </p>
                  )
                ) : (
                  <p className="awb-detail__empty">
                    Select an assistant turn to inspect its process details.
                  </p>
                )}
              </section>

              <section className="awb-inspector__section">
                <ChatTreePanel
                  chatTree={activeChatTree}
                  loading={chatTreeLoading}
                  error={chatTreeError}
                  onJump={(nodeId) => void onJumpChatTree(nodeId)}
                />
              </section>
            </div>
          </section>
        </aside>
      </div>
      {sessionMenuMarkup &&
        (typeof document === "undefined"
          ? sessionMenuMarkup
          : createPortal(sessionMenuMarkup, document.body))}
      {settingsModalMarkup &&
        (typeof document === "undefined"
          ? settingsModalMarkup
          : createPortal(settingsModalMarkup, document.body))}
    </>
  );
};
