import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import type {
  AgentDescriptor,
  ChatTreeSnapshotRpc,
  SessionActionDescriptorRpc,
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
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
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
import "./chat-shell.css";

type SessionMenuState = {
  sessionId: string;
  x: number;
  y: number;
  actions: SessionActionDescriptorRpc[];
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
  const [expandedCompletedTurnIds, setExpandedCompletedTurnIds] = useState<Record<string, true>>(
    {}
  );
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | undefined>();
  const [pendingRestoreSessionId, setPendingRestoreSessionId] = useState<string | undefined>();
  const [startupRestoreState, setStartupRestoreState] = useState<
    "idle" | "scheduled" | "done"
  >("idle");

  const activeWorkspace = workspaceTree.find((workspace) => workspace.isActive);
  const activeSessionNode =
    findActiveSessionNode(workspaceTree) ??
    (state.activeSessionId
      ? findSessionNode(workspaceTree, state.activeSessionId)
      : undefined);
  const activeSessionId = state.activeSessionId ?? activeSessionNode?.sessionId;
  const activeSession = activeSessionId
    ? state.entities.sessions[activeSessionId]
    : undefined;
  const activeConversation =
    ((activeSession?.conversationId ?? activeSessionNode?.conversationId)
      ? state.entities.conversations[
          (activeSession?.conversationId ?? activeSessionNode?.conversationId)!
        ]
      : undefined) ??
    (activeSession?.conversationId
      ? state.entities.conversations[activeSession.conversationId]
      : undefined) ??
    (state.activeConversationId
      ? state.entities.conversations[state.activeConversationId]
      : undefined);
  const turns = activeSessionId
    ? selectTurnsForSession(state, activeSessionId)
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
    () => filterTranscriptRowsForChatTree(transcriptRows, chatTree),
    [transcriptRows, chatTree]
  );

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
            conversationId: activeConversation?.conversationId ?? "",
            agentId: activeSessionNode?.agentId ?? selectedAgentId,
            status: "idle",
            createdAt: "",
            updatedAt: ""
          } as NonNullable<typeof activeSession>)
        : undefined),
    approvals: visibleTranscriptRows.at(-1)?.approvals ?? [],
    notice: statusNotice
  });

  const hydrateOpenedSession = async (sessionId: string): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.sessionBrowser.open(sessionId);
    const snapshotResult = await transport.domain.snapshot();
    store.hydrateSnapshot(snapshotResult.snapshot);
    const session = store.getState().entities.sessions[sessionId];
    if (session) {
      store.dispatch({
        type: "store/setActiveConversation",
        conversationId: session.conversationId
      });
      store.dispatch({
        type: "store/setActiveSession",
        sessionId
      });
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
    if (
      startupRestoreState === "idle" &&
      !state.activeSessionId &&
      workspaceState.lastActiveSessionId
    ) {
      setPendingRestoreSessionId(workspaceState.lastActiveSessionId);
      setStartupRestoreState("scheduled");
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
  };

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
  }, [transport, state.eventStream.lastCursor, startupRestoreState]);

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
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0]!.agentId);
    }
  }, [agents, selectedAgentId]);

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
    if (
      !transport ||
      !pendingRestoreSessionId ||
      state.activeSessionId ||
      startupRestoreState !== "scheduled"
    ) {
      return;
    }
    if (!findSessionNode(workspaceTree, pendingRestoreSessionId)) {
      return;
    }
    let disposed = false;
    const restoreTimeoutId = window.setTimeout(() => {
      if (disposed) {
        return;
      }
      setStatusNotice({
        message: "Restoring last session…",
        persistent: true,
        source: "session-browser"
      });
      void hydrateOpenedSession(pendingRestoreSessionId)
        .then(async () => {
          if (disposed) {
            return;
          }
          setPendingRestoreSessionId(undefined);
          setStartupRestoreState("done");
          await refreshSessionBrowser({
            mode: "workspace",
            workspaceId: findSessionNode(workspaceTree, pendingRestoreSessionId)?.workspaceId
          });
        })
        .catch((error) => {
          if (!disposed) {
            setStatusNotice({
              message: `Restore session failed: ${(error as Error).message}`,
              persistent: true,
              source: "session-browser"
            });
            setPendingRestoreSessionId(undefined);
            setStartupRestoreState("done");
          }
        });
    }, 1_500);
    return () => {
      disposed = true;
      window.clearTimeout(restoreTimeoutId);
    };
  }, [
    transport,
    pendingRestoreSessionId,
    startupRestoreState,
    state.activeSessionId,
    workspaceTree
  ]);

  useEffect(() => {
    if (!transport || !activeSessionId) {
      setChatTree(undefined);
      setChatTreeError(undefined);
      setChatTreeLoading(false);
      return;
    }
    let disposed = false;
    setChatTreeLoading(true);
    setChatTreeError(undefined);
    void transport.chatTree
      .get(activeSessionId)
      .then((nextTree) => {
        if (!disposed) {
          setChatTree(nextTree);
          setChatTreeError(undefined);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setChatTreeError((error as Error).message);
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
  }, [transport, activeSessionId, state.eventStream.lastCursor]);

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

  const onToggleWorkspace = async (workspaceId: string): Promise<void> => {
    if (!transport) {
      return;
    }
    setPendingRestoreSessionId(undefined);
    setStartupRestoreState("done");
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
    setPendingRestoreSessionId(undefined);
    setStartupRestoreState("done");
    setStatusNotice({
      message: "Creating session…",
      persistent: true,
      source: "create-session"
    });
    try {
      const created = await transport.sessionBrowser.create({
        workspaceId,
        agentId: selectedAgentId
      });
      await hydrateOpenedSession(created.sessionId);
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId
      });
      setStatusNotice({
        message: `Created session for ${selectedAgentId}`,
        source: "create-session"
      });
    } catch (error) {
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
    setPendingRestoreSessionId(undefined);
    setStartupRestoreState("done");
    setStatusNotice({
      message: "Opening session…",
      persistent: true,
      source: "session-browser"
    });
    try {
      await hydrateOpenedSession(sessionId);
      await refreshSessionBrowser({
        mode: "workspace",
        workspaceId: findSessionNode(workspaceTree, sessionId)?.workspaceId
      });
      setStatusNotice(undefined);
    } catch (error) {
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
        const fileUrl = encodeURI(
          `file:///${result.rolloutPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1:")}`
        );
        window.open(fileUrl, "_blank", "noopener,noreferrer");
        setStatusNotice({
          message: `Opened rollout ${result.rolloutPath}`,
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
    if (!transport || !activeSessionId) {
      return;
    }
    await transport.chatTree.jump({
      sessionId: activeSessionId,
      nodeId
    });
    const nextTree = await transport.chatTree.get(activeSessionId);
    setChatTree(nextTree);
    setStatusNotice({
      message: `Jumped to ${nodeId}`,
      source: "chat-tree"
    });
  };

  const toggleCompletedTurnProcess = (turnId: string): void => {
    setExpandedCompletedTurnIds((current) => {
      if (current[turnId]) {
        const next = { ...current };
        delete next[turnId];
        return next;
      }
      return {
        ...current,
        [turnId]: true
      };
    });
  };

  const renderSessionNode = (
    session: WorkspaceBrowserNodeRpc["sessions"][number],
    depth = 0
  ): ReactElement => {
    const statusDot = resolveStatusDotLabel(session.statusDot);
    return (
      <li key={session.sessionId} className="awb-tree__item">
        <div
          className={`awb-tree__session ${session.isActive ? "is-active" : ""}`}
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

  return (
    <div className="awb-shell">
      <aside className="awb-shell__sidebar">
        <header className="awb-sidebar__header">
          <h1>{title}</h1>
          <p>Workspace-centered multi-agent shell</p>
        </header>

        <section className="awb-sidebar__section">
          <div className="awb-sidebar__section-header">
            <h2>Agent</h2>
          </div>
          <label className="awb-field">
            <span>New session agent</span>
            <select
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              <option value="">Select an agent</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
        </section>

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
      </aside>

      <main className="awb-shell__main">
        <header className="awb-main__header">
          <div>
            <h2>Transcript</h2>
            <p>
              {activeSessionId
                ? `${activeSessionNode?.displaySessionId ?? activeSessionId} · ${turns.length} turn(s)`
                : "Select a session to view transcript"}
            </p>
          </div>
        </header>

        <section className="awb-transcript">
          {visibleTranscriptRows.length === 0 && (
            <div className="awb-transcript__empty">
              <h3>{activeSessionId ? "No messages yet" : "No transcript yet"}</h3>
              <p>
                {activeSessionId
                  ? "This session is selected and ready. Send a message to start the conversation."
                  : "Open a session from the workspace tree or create a new one to start."}
              </p>
            </div>
          )}

          {visibleTranscriptRows.map((row) => {
            const isUserTurn = row.messageRole === "user";
            const processExpanded =
              !isUserTurn &&
              (row.turn.status !== "completed" ||
                Boolean(expandedCompletedTurnIds[row.turn.turnId]));
            return (
              <article
                key={row.rowId}
                className={`awb-chat-entry ${isUserTurn ? "is-user" : "is-assistant"}`}
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

                {!isUserTurn && row.hasProcessDetails && (
                  <section className={`awb-turn__process ${processExpanded ? "is-expanded" : ""}`}>
                    <div className="awb-turn__process-summary">
                      <span>
                        {row.turn.status === "completed"
                          ? "Process details hidden by default after completion."
                          : "Process details stay open while the turn is still running."}
                      </span>
                      {row.turn.status === "completed" && (
                        <button
                          type="button"
                          className="awb-secondary-button awb-secondary-button--small"
                          onClick={() => toggleCompletedTurnProcess(row.turn.turnId)}
                        >
                          {processExpanded ? "Hide process" : "Show process"}
                        </button>
                      )}
                    </div>
                    {processExpanded && (
                      <TurnProcessPanel
                        row={row}
                        participantDirectory={participantDirectory}
                        onRespondApproval={transport ? onRespondApproval : undefined}
                      />
                    )}
                  </section>
                )}
                <footer className="awb-chat-entry__meta">
                  <ParticipantIdentityBadge identity={row.turnIdentity} compact />
                  <span>{formatTimestamp(row.turn.completedAt ?? row.turn.startedAt)}</span>
                </footer>
              </article>
            );
          })}
        </section>

        <footer className="awb-composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type a prompt for the active session..."
          />
          <div className="awb-composer__actions">
            <span className="awb-status">{status}</span>
            <button type="button" onClick={() => void onSend()}>
              Send
            </button>
          </div>
        </footer>
      </main>

      <aside className="awb-shell__detail">
        <header className="awb-detail__header">
          <h2>Chat Tree</h2>
        </header>

        <section className="awb-detail__body">
          <ChatTreePanel
            chatTree={chatTree}
            loading={chatTreeLoading}
            error={chatTreeError}
            onJump={(nodeId) => void onJumpChatTree(nodeId)}
          />
        </section>
      </aside>

      {sessionMenu && (
        <div
          className="awb-session-menu"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
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
      )}
    </div>
  );
};
