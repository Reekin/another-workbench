import {
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentDescriptor,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  SessionWindowRpc,
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
import { ChatTreePanel } from "./ChatTreePanel.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";
import {
  resolveProcessExpanded,
  toggleProcessVisibility,
  type ProcessVisibilityOverride
} from "./process-visibility.js";
import { TurnProcessPanel } from "./TurnProcessPanel.js";
import { buildParticipantDirectory } from "./participant-directory.js";
import { type ComposerStatusNotice } from "./composer-status.js";
import { filterTranscriptRowsForChatTree } from "./chat-tree-transcript.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import { useRendererStoreState } from "./use-renderer-store-state.js";
import {
  findActiveSessionNode,
  findSessionNode
} from "./workspace-browser-tree.js";
import { useTranscriptViewportController } from "./use-transcript-viewport-controller.js";
import { useWorkspaceBrowserController } from "./use-workspace-browser-controller.js";
import { useSessionOpenController } from "./use-session-open-controller.js";
import {
  useSessionActionsController,
  type SessionMenuState
} from "./use-session-actions-controller.js";
import { useComposerController } from "./use-composer-controller.js";
import { useChatTreeController } from "./use-chat-tree-controller.js";
import { buildEngineInspectorViewModel } from "./engine-summary.js";
import { ComposerPanel } from "./composer/ComposerPanel.js";
import "./chat-shell.css";

type SettingsLauncherProps = {
  agents: AgentDescriptor[];
  engines: EngineDefinitionRpc[];
  surfacesByEngineId: Readonly<Record<string, EngineSurfaceRpc | undefined>>;
  currentAgentId: string;
  transport?: DesktopTransport;
  onAgentSaved: (agentId: string) => void;
  onStatusNotice: (notice: ComposerStatusNotice) => void;
};

type TranscriptPaneProps = {
  transcriptRef: RefObject<HTMLElement | null>;
  renderedTranscriptRows: ReturnType<typeof buildTurnTranscriptRows>;
  participantDirectory: ReturnType<typeof buildParticipantDirectory>;
  activeSessionWindow?: SessionWindowRpc;
  activeSessionId?: string;
  isOpeningSelectedSession: boolean;
  loadingOlderTurns: boolean;
  onLoadOlder: () => void;
  processVisibilityByTurnId: Readonly<Record<string, ProcessVisibilityOverride>>;
  onToggleProcess: (turnId: string) => void;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
  }) => Promise<void>;
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

const sessionActionLabel = (
  action: SessionMenuState["actions"][number]
): string => action.label;

const summarizeProcessToggle = (input: {
  toolCount: number;
  terminalCount: number;
  approvalCount: number;
}): string => {
  const parts: string[] = [];
  if (input.toolCount > 0) {
    parts.push(`${input.toolCount} tool${input.toolCount === 1 ? "" : "s"}`);
  }
  if (input.terminalCount > 0) {
    parts.push(
      `${input.terminalCount} terminal${input.terminalCount === 1 ? "" : "s"}`
    );
  }
  if (input.approvalCount > 0) {
    parts.push(
      `${input.approvalCount} approval${input.approvalCount === 1 ? "" : "s"}`
    );
  }
  return parts.join(" · ");
};

const TranscriptPane = memo(
  ({
    transcriptRef,
    renderedTranscriptRows,
    participantDirectory,
    activeSessionWindow,
    activeSessionId,
    isOpeningSelectedSession,
    loadingOlderTurns,
    onLoadOlder,
    processVisibilityByTurnId,
    onToggleProcess,
    onRespondApproval
  }: TranscriptPaneProps): ReactElement => (
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
            onClick={onLoadOlder}
            disabled={loadingOlderTurns || isOpeningSelectedSession}
          >
            {loadingOlderTurns ? "Loading earlier…" : "Load earlier"}
          </button>
        </div>
      )}

      {renderedTranscriptRows.map((row) => {
        const isUserTurn = row.messageRole === "user";
        const isProcessExpanded =
          !isUserTurn &&
          row.hasProcessDetails &&
          resolveProcessExpanded(
            row.defaultProcessExpanded,
            processVisibilityByTurnId[row.turn.turnId]
          );
        const processSummary = summarizeProcessToggle({
          toolCount: row.toolCalls.length,
          terminalCount: row.terminalStreams.length,
          approvalCount: row.approvals.length
        });
        return (
          <article
            key={row.rowId}
            data-turn-id={row.turn.turnId}
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
              <div className="awb-turn__process">
                <button
                  type="button"
                  className="awb-turn__process-toggle"
                  onClick={() => onToggleProcess(row.turn.turnId)}
                  aria-expanded={isProcessExpanded}
                >
                  <span>
                    {isProcessExpanded ? "Hide process output" : "Show process output"}
                  </span>
                  <span>{processSummary}</span>
                </button>
                {isProcessExpanded && (
                  <TurnProcessPanel
                    row={row}
                    participantDirectory={participantDirectory}
                    onRespondApproval={onRespondApproval}
                  />
                )}
              </div>
            )}
            <footer className="awb-chat-entry__meta">
              <span>{formatTimestamp(row.turn.completedAt ?? row.turn.startedAt)}</span>
            </footer>
          </article>
        );
      })}
    </section>
  ),
  (previous, next) =>
    previous.renderedTranscriptRows === next.renderedTranscriptRows &&
    previous.participantDirectory === next.participantDirectory &&
    previous.activeSessionWindow === next.activeSessionWindow &&
    previous.activeSessionId === next.activeSessionId &&
    previous.isOpeningSelectedSession === next.isOpeningSelectedSession &&
    previous.loadingOlderTurns === next.loadingOlderTurns &&
    previous.processVisibilityByTurnId === next.processVisibilityByTurnId &&
    previous.transcriptRef === next.transcriptRef
);

const SettingsLauncher = ({
  agents,
  engines,
  surfacesByEngineId,
  currentAgentId,
  transport,
  onAgentSaved,
  onStatusNotice
}: SettingsLauncherProps): ReactElement => {
  const [isOpen, setIsOpen] = useState(false);
  const [draftAgentId, setDraftAgentId] = useState(currentAgentId);
  const [isSaving, setIsSaving] = useState(false);
  const engineInspector = useMemo(
    () =>
      buildEngineInspectorViewModel({
        selectedEngineId: draftAgentId || currentAgentId,
        engines,
        surfacesByEngineId
      }),
    [currentAgentId, draftAgentId, engines, surfacesByEngineId]
  );
  const tierByEngineId = useMemo(
    () =>
      Object.fromEntries(
        engines.map((engine) => [engine.engineId, engine.integrationTier] as const)
      ),
    [engines]
  );

  useEffect(() => {
    if (!isOpen) {
      setDraftAgentId(currentAgentId);
    }
  }, [currentAgentId, isOpen]);

  const close = (): void => {
    setIsOpen(false);
  };

  const open = (): void => {
    setDraftAgentId(currentAgentId);
    setIsOpen(true);
  };

  const onSave = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    setIsSaving(true);
    try {
      const result = await transport.settings.update({
        defaultNewSessionAgentId: draftAgentId || undefined
      });
      const nextAgentId = result.defaultNewSessionAgentId ?? "";
      onAgentSaved(nextAgentId);
      close();
      onStatusNotice({
        message: result.defaultNewSessionAgentId
          ? `Default agent set to ${result.defaultNewSessionAgentId}`
          : "Default agent cleared.",
        source: "settings"
      });
    } catch (error) {
      onStatusNotice({
        message: `Settings save failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings"
      });
    } finally {
      setIsSaving(false);
    }
  };

  const modalMarkup = isOpen ? (
    <div className="awb-modal-scrim" role="presentation" onClick={close}>
      <section
        className="awb-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="awb-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="awb-modal__header">
          <div>
            <span className="awb-main__eyebrow">Settings</span>
            <h2 id="awb-settings-title">Preferences</h2>
          </div>
          <button type="button" className="awb-ghost-button" onClick={close}>
            Close
          </button>
        </header>
        <div className="awb-modal__body">
          <label className="awb-field">
            <span>New session agent</span>
            <select
              value={draftAgentId}
              onChange={(event) => setDraftAgentId(event.target.value)}
            >
              <option value="">Follow first available agent</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {tierByEngineId[agent.agentId]
                    ? `${agent.displayName} (${tierByEngineId[agent.agentId]})`
                    : agent.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="awb-field" aria-live="polite">
            <span>Selected engine</span>
            <strong>{engineInspector.engineLabel}</strong>
            <span>{engineInspector.integrationLabel}</span>
            <span>{engineInspector.capabilitiesLabel}</span>
            <span>{engineInspector.extensionsLabel}</span>
          </div>
        </div>
        <footer className="awb-modal__footer">
          <button type="button" className="awb-ghost-button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="awb-secondary-button"
            onClick={() => void onSave()}
            disabled={isSaving}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className="awb-sidebar__settings"
        onClick={open}
        aria-label="Open settings"
        title="Settings"
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {modalMarkup &&
        (typeof document === "undefined"
          ? modalMarkup
          : createPortal(modalMarkup, document.body))}
    </>
  );
};

export const ChatShellApp = ({
  store,
  transport,
  title = "Another Workbench"
}: ChatShellAppProps): ReactElement => {
  const state = useRendererStoreState(store);
  const [availableAgents, setAvailableAgents] = useState<AgentDescriptor[]>([]);
  const [availableEngines, setAvailableEngines] = useState<EngineDefinitionRpc[]>([]);
  const [engineSurfacesById, setEngineSurfacesById] = useState<
    Record<string, EngineSurfaceRpc | undefined>
  >({});
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [statusNotice, setStatusNotice] = useState<ComposerStatusNotice | undefined>();
  const [sessionWindows, setSessionWindows] = useState<
    Record<string, SessionWindowRpc | undefined>
  >({});
  const [loadingOlderSessionId, setLoadingOlderSessionId] = useState<
    string | undefined
  >();
  const [browserSelectedSessionId, setBrowserSelectedSessionId] = useState<
    string | undefined
  >();
  const [openingSessionId, setOpeningSessionId] = useState<string | undefined>();
  const [processVisibilityByTurnId, setProcessVisibilityByTurnId] = useState<
    Record<string, ProcessVisibilityOverride>
  >({});
  const [settingsHydrated, setSettingsHydrated] = useState(false);

  const {
    workspaceTree,
    refreshSessionBrowser,
    onAddWorkspace,
    onToggleWorkspace,
    onToggleSessionTree
  } = useWorkspaceBrowserController({
    transport,
    eventCursor: state.eventStream.lastCursor,
    onStatusNotice: setStatusNotice
  });

  const activeWorkspace = workspaceTree.find((workspace) => workspace.isActive);
  const activeSessionNode =
    findActiveSessionNode(workspaceTree) ??
    (state.activeSessionId
      ? findSessionNode(workspaceTree, state.activeSessionId)
      : undefined);
  const activeSessionId = state.activeSessionId ?? activeSessionNode?.sessionId;
  const displayedSessionId =
    openingSessionId ?? browserSelectedSessionId ?? activeSessionId;
  const activeSessionWindow =
    displayedSessionId ? sessionWindows[displayedSessionId] : undefined;
  const loadingOlderTurns = loadingOlderSessionId === displayedSessionId;
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

  const viewport = useTranscriptViewportController({
    displayedSessionId,
    isOpeningSelectedSession,
    windowStartTurnId: activeSessionWindow?.windowStartTurnId,
    windowEndTurnId: activeSessionWindow?.windowEndTurnId,
    renderedTranscriptRowCount: transcriptRows.length
  });

  const resetSessionSwitchState = (): void => {
    setLoadingOlderSessionId(undefined);
    setProcessVisibilityByTurnId({});
  };

  const { reloadSessionWindow, onLoadOlder, onCreateSession, onOpenSession } =
    useSessionOpenController({
      store,
      transport,
      workspaceTree,
      sessionWindows,
      setSessionWindows,
      loadingOlderSessionId,
      setLoadingOlderSessionId,
      browserSelectedSessionId,
      setBrowserSelectedSessionId,
      openingSessionId,
      setOpeningSessionId,
      displayedSessionId,
      activeSessionWindow,
      isOpeningSelectedSession,
      viewport,
      onResetSessionSwitchState: resetSessionSwitchState,
      onStatusNotice: setStatusNotice,
      refreshSessionBrowser
    });

  const {
    chatTree,
    onJumpChatTree
  } = useChatTreeController({
    transport,
    browsedSessionId,
    displayedSessionId,
    displayedSessionIdRef: viewport.displayedSessionIdRef,
    isOpeningSelectedSession,
    eventCursor: state.eventStream.lastCursor,
    onStatusNotice: setStatusNotice,
    reloadSessionWindow
  });
  const activeChatTree =
    chatTree?.sessionId === displayedSessionId ? chatTree : undefined;
  const visibleTranscriptRows = useMemo(
    () => filterTranscriptRowsForChatTree(transcriptRows, activeChatTree),
    [transcriptRows, activeChatTree]
  );
  const renderedTranscriptRows = isOpeningSelectedSession ? [] : visibleTranscriptRows;

  const { sessionMenu, onOpenSessionMenu, onRunSessionAction } =
    useSessionActionsController({
      transport,
      workspaceTree,
      refreshSessionBrowser,
      onStatusNotice: setStatusNotice
    });

  const fallbackAgents = useMemo(
    () => buildWorkspaceAgentFallbacks(workspaceTree),
    [workspaceTree]
  );
  const agents = useMemo(
    () => uniqueByAgentId([...availableAgents, ...fallbackAgents]),
    [availableAgents, fallbackAgents]
  );

  const composer = useComposerController({
    transport,
    activeSession,
    activeSessionId,
    displayedSessionId,
    selectedAgentId,
    activeWorkspaceId: activeWorkspace?.workspaceId,
    activeWorkspaceRootPath: activeWorkspace?.rootPath,
    turns,
    approvals: renderedTranscriptRows.at(-1)?.approvals ?? [],
    isOpeningSelectedSession,
    statusNotice,
    onStatusNotice: setStatusNotice,
    onCreateSession,
    onOpenSession
  });

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
    if (!transport) {
      return;
    }
    let disposed = false;
    void transport.engine
      .list()
      .then((list) => {
        if (!disposed) {
          setAvailableEngines(list);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Engine list failed: ${(error as Error).message}`,
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
    if (!transport || !selectedAgentId) {
      return;
    }
    let disposed = false;
    void transport.engine
      .getSurface(selectedAgentId)
      .then((surface) => {
        if (!disposed) {
          setEngineSurfacesById((current) => ({
            ...current,
            [selectedAgentId]: surface
          }));
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Engine surface failed: ${(error as Error).message}`,
            persistent: true,
            source: "settings"
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

  const onToggleProcess = (turnId: string): void => {
    const row = renderedTranscriptRows.find((candidate) => candidate.turn.turnId === turnId);
    if (!row) {
      return;
    }
    setProcessVisibilityByTurnId((current) =>
      toggleProcessVisibility(current, turnId, row.defaultProcessExpanded)
    );
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
                    <div className="awb-workspace__main">
                      <span className="awb-workspace__disclosure" aria-hidden="true">
                        {workspace.isExpanded ? "▾" : "▸"}
                      </span>
                      <div>
                        <strong>{workspace.label}</strong>
                        <span>{workspace.rootPath}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="awb-workspace__add"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onCreateSession(workspace.workspaceId, selectedAgentId);
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
            <SettingsLauncher
              agents={agents}
              engines={availableEngines}
              surfacesByEngineId={engineSurfacesById}
              currentAgentId={selectedAgentId}
              transport={transport}
              onAgentSaved={setSelectedAgentId}
              onStatusNotice={setStatusNotice}
            />
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
            <TranscriptPane
              transcriptRef={viewport.transcriptRef}
              renderedTranscriptRows={renderedTranscriptRows}
              participantDirectory={participantDirectory}
              activeSessionWindow={activeSessionWindow}
              activeSessionId={activeSessionId}
              isOpeningSelectedSession={isOpeningSelectedSession}
              loadingOlderTurns={loadingOlderTurns}
              onLoadOlder={() => void onLoadOlder()}
              processVisibilityByTurnId={processVisibilityByTurnId}
              onToggleProcess={onToggleProcess}
              onRespondApproval={transport ? onRespondApproval : undefined}
            />
          </div>

          <ComposerPanel
            isDropTarget={composer.isDropTarget}
            fileInputRef={composer.composerFileInputRef}
            textareaRef={composer.composerTextareaRef}
            draft={composer.draft}
            selectedSkills={composer.selectedSkills}
            attachments={composer.attachments}
            queue={composer.queue}
            suggestions={composer.suggestions}
            status={composer.status}
            intent={composer.intent}
            supportsSteer={composer.capabilities.supportsSteer}
            canSubmit={composer.canSubmit}
            canQueue={composer.canQueue}
            canStop={composer.canStop}
            isDispatching={composer.isDispatching}
            onTextareaChange={composer.onDraftChange}
            onTextareaSelect={composer.onTextareaSelect}
            onInputKeyDown={composer.onInputKeyDown}
            onPaste={composer.onComposerPaste}
            onFileInputChange={composer.onComposerInputChange}
            onDragEnter={composer.onComposerDragEnter}
            onDragOver={composer.onComposerDragOver}
            onDragLeave={composer.onComposerDragLeave}
            onDrop={composer.onComposerDrop}
            onRemoveSkill={composer.onRemoveSkill}
            onRemoveAttachment={composer.onRemoveAttachment}
            onPickAttachments={composer.onPickAttachments}
            onPrimaryAction={composer.onPrimaryAction}
            onQueueCurrent={composer.onQueueCurrent}
            onStop={composer.onStop}
            onSuggestionHover={composer.onSuggestionHover}
            onSuggestionSelect={async (index) => {
              const item = composer.suggestions?.items[index];
              if (item) {
                await composer.onSuggestionSelect(item);
              }
            }}
            onEditQueuedMessage={composer.onEditQueuedMessage}
            onDeleteQueuedMessage={composer.onDeleteQueuedMessage}
            onSendQueuedMessageNow={composer.onSendQueuedMessageNow}
            onSteerQueuedMessageNow={composer.onSteerQueuedMessageNow}
          />
        </main>

        <aside className="awb-shell__detail" aria-label="Session details">
          <div className="awb-detail__spacer" aria-hidden="true" />
          <section className="awb-detail__graph">
            <ChatTreePanel
              chatTree={activeChatTree}
              onJump={transport ? (nodeId) => void onJumpChatTree(nodeId) : undefined}
            />
          </section>
        </aside>
      </div>
      {sessionMenuMarkup &&
        (typeof document === "undefined"
          ? sessionMenuMarkup
          : createPortal(sessionMenuMarkup, document.body))}
    </>
  );
};
