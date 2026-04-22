import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactElement,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentDescriptor,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  ExtractedFileReference,
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
import { renderTurnExtensions } from "../../features/engine-extensions/turn-extension-registry.js";
import { ChatTreePanel } from "./ChatTreePanel.js";
import { FilesDetailPanel } from "./FilesDetailPanel.js";
import { ImageLightbox, type ImageLightboxState } from "./ImageLightbox.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";
import {
  resolveProcessExpanded,
  toggleProcessVisibility,
  type ProcessVisibilityOverride
} from "./process-visibility.js";
import { TurnProcessPanel } from "./TurnProcessPanel.js";
import {
  createComposerAttachments,
  mergeComposerAttachments,
  releaseComposerAttachments,
  type ComposerAttachment
} from "./composer-attachments.js";
import { buildParticipantDirectory } from "./participant-directory.js";
import {
  resolveComposerStatus,
  type ComposerStatusNotice
} from "./composer-status.js";
import { filterTranscriptRowsForChatTree } from "./chat-tree-transcript.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import { useFileBrowserController } from "./use-file-browser-controller.js";
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
import { useChatTreeController } from "./use-chat-tree-controller.js";
import { buildEngineInspectorViewModel } from "./engine-summary.js";
import "./chat-shell.css";

type SettingsLauncherProps = {
  agents: AgentDescriptor[];
  engines: EngineDefinitionRpc[];
  surfacesByEngineId: Readonly<Record<string, EngineSurfaceRpc | undefined>>;
  currentEngineId: string;
  transport?: DesktopTransport;
  onEngineSaved: (engineId: string) => void;
  onStatusNotice: (notice: ComposerStatusNotice) => void;
};

type TranscriptPaneProps = {
  transcriptRef: RefObject<HTMLElement | null>;
  renderedTranscriptRows: ReturnType<typeof buildTurnTranscriptRows>;
  participantDirectory: ReturnType<typeof buildParticipantDirectory>;
  transport?: DesktopTransport;
  engineId?: string;
  engineSurface?: EngineSurfaceRpc;
  activeSessionWindow?: SessionWindowRpc;
  activeSessionId?: string;
  isOpeningSelectedSession: boolean;
  loadingOlderTurns: boolean;
  onLoadOlder: () => void;
  processVisibilityByTurnId: Readonly<Record<string, ProcessVisibilityOverride>>;
  onToggleProcess: (turnId: string) => void;
  onActivateResourceLink: (reference: ExtractedFileReference) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
  }) => Promise<void>;
};

type DetailTab = "graph" | "files";

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

const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.types ?? []).includes("Files");

const hasStringTransfer = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.items ?? []).some((item) => item.kind === "string");

const collectPastedImageFiles = (dataTransfer: DataTransfer | null): File[] => {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.items)
    .filter(
      (item) =>
        item.kind === "file" && item.type.toLowerCase().startsWith("image/")
    )
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
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
    transport,
    engineId,
    engineSurface,
    activeSessionWindow,
    activeSessionId,
    isOpeningSelectedSession,
    loadingOlderTurns,
    onLoadOlder,
    processVisibilityByTurnId,
    onToggleProcess,
    onActivateResourceLink,
    onPreviewImage,
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
                  onActivateResourceLink={onActivateResourceLink}
                  onPreviewImage={onPreviewImage}
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
            {!isUserTurn
              ? renderTurnExtensions({
                  transport,
                  engineId,
                  engineSurface,
                  sessionId: row.turn.sessionId,
                  turnId: row.turn.turnId
                })
              : null}
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
    previous.transport === next.transport &&
    previous.engineId === next.engineId &&
    previous.engineSurface === next.engineSurface &&
    previous.activeSessionWindow === next.activeSessionWindow &&
    previous.activeSessionId === next.activeSessionId &&
    previous.isOpeningSelectedSession === next.isOpeningSelectedSession &&
    previous.loadingOlderTurns === next.loadingOlderTurns &&
    previous.processVisibilityByTurnId === next.processVisibilityByTurnId &&
    previous.transcriptRef === next.transcriptRef &&
    previous.onActivateResourceLink === next.onActivateResourceLink &&
    previous.onPreviewImage === next.onPreviewImage
);

const SettingsLauncher = ({
  agents,
  engines,
  surfacesByEngineId,
  currentEngineId,
  transport,
  onEngineSaved,
  onStatusNotice
}: SettingsLauncherProps): ReactElement => {
  const [isOpen, setIsOpen] = useState(false);
  const [draftEngineId, setDraftEngineId] = useState(currentEngineId);
  const [isSaving, setIsSaving] = useState(false);
  const engineInspector = useMemo(
    () =>
      buildEngineInspectorViewModel({
        selectedEngineId: draftEngineId || currentEngineId,
        engines,
        surfacesByEngineId
      }),
    [currentEngineId, draftEngineId, engines, surfacesByEngineId]
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
      setDraftEngineId(currentEngineId);
    }
  }, [currentEngineId, isOpen]);

  const close = (): void => {
    setIsOpen(false);
  };

  const open = (): void => {
    setDraftEngineId(currentEngineId);
    setIsOpen(true);
  };

  const onSave = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    setIsSaving(true);
    try {
      const result = await transport.settings.update({
        defaultNewSessionEngineId: draftEngineId || undefined
      });
      const nextEngineId = result.defaultNewSessionEngineId ?? "";
      onEngineSaved(nextEngineId);
      close();
      onStatusNotice({
        message: result.defaultNewSessionEngineId
          ? `Default engine set to ${result.defaultNewSessionEngineId}`
          : "Default engine cleared.",
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
            <span>New session engine</span>
            <select
              value={draftEngineId}
              onChange={(event) => setDraftEngineId(event.target.value)}
            >
              <option value="">Follow first available engine</option>
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
  const [selectedEngineId, setSelectedEngineId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>(
    []
  );
  const [isSendingComposer, setIsSendingComposer] = useState(false);
  const [isComposerDropTarget, setIsComposerDropTarget] = useState(false);
  const [statusNotice, setStatusNotice] = useState<ComposerStatusNotice | undefined>();
  const [sessionWindows, setSessionWindows] = useState<
    Record<string, SessionWindowRpc | undefined>
  >({});
  const [loadingOlderSessionId, setLoadingOlderSessionId] = useState<
    string | undefined
  >();
  const [detailTab, setDetailTab] = useState<DetailTab>("graph");
  const [browserSelectedSessionId, setBrowserSelectedSessionId] = useState<
    string | undefined
  >();
  const [openingSessionId, setOpeningSessionId] = useState<string | undefined>();
  const [processVisibilityByTurnId, setProcessVisibilityByTurnId] = useState<
    Record<string, ProcessVisibilityOverride>
  >({});
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxState | undefined>();
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const mountedRef = useRef(true);
  const composerAttachmentsRef = useRef<ComposerAttachment[]>([]);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerDropDepthRef = useRef(0);

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
  const displayedEngineId =
    displayedSession?.agentId ?? displayedSessionNode?.agentId ?? selectedEngineId;
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

  const fileBrowser = useFileBrowserController({
    transport,
    activeWorkspaceId: activeWorkspace?.workspaceId,
    onStatusNotice: setStatusNotice
  });

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

  const status = resolveComposerStatus({
    transportAvailable: Boolean(transport),
    selectedEngineId,
    activeSession:
      activeSession ??
      (activeSessionId
        ? ({
            sessionId: activeSessionId,
            conversationId: displayedConversationId ?? "",
            agentId: displayedSessionNode?.agentId ?? selectedEngineId,
            status: "idle",
            createdAt: "",
            updatedAt: ""
          } as NonNullable<typeof activeSession>)
        : undefined),
    approvals: renderedTranscriptRows.at(-1)?.approvals ?? [],
    notice: statusNotice
  });
  const hasDraftText = draft.trim().length > 0;
  const isComposerBusy = isOpeningSelectedSession || isSendingComposer;
  const canSendComposerPayload =
    (hasDraftText || composerAttachments.length > 0) &&
    Boolean(activeSessionId) &&
    Boolean(transport) &&
    !isComposerBusy;

  useEffect(() => {
    composerAttachmentsRef.current = composerAttachments;
  }, [composerAttachments]);

  useEffect(() => {
    return () => {
      releaseComposerAttachments(composerAttachmentsRef.current);
    };
  }, []);

  useEffect(() => {
    clearComposerAttachments();
  }, [activeSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
            source: "engine-list"
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
    if (settingsHydrated && !selectedEngineId && agents.length > 0) {
      setSelectedEngineId(agents[0]!.agentId);
    }
  }, [agents, selectedEngineId, settingsHydrated]);

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
        if (settings.defaultNewSessionEngineId) {
          setSelectedEngineId(settings.defaultNewSessionEngineId);
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
    if (!transport || !selectedEngineId) {
      return;
    }
    let disposed = false;
    void transport.agent
      .select({ agentId: selectedEngineId })
      .then(() => {
        if (!disposed) {
          setStatusNotice(undefined);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Engine select failed: ${(error as Error).message}`,
            persistent: true,
            source: "engine-select"
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport, selectedEngineId]);

  useEffect(() => {
    const engineIds = [selectedEngineId, displayedEngineId].filter(
      (engineId): engineId is string => Boolean(engineId)
    );
    const nextEngineId = engineIds.find((engineId) => !engineSurfacesById[engineId]);
    if (!transport || !nextEngineId) {
      return;
    }
    let disposed = false;
    void transport.engine
      .getSurface(nextEngineId)
      .then((surface) => {
        if (!disposed) {
          setEngineSurfacesById((current) => ({
            ...current,
            [nextEngineId]: surface
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
  }, [displayedEngineId, engineSurfacesById, selectedEngineId, transport]);

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

  const overwriteComposerAttachments = (attachments: ComposerAttachment[]): void => {
    composerAttachmentsRef.current = attachments;
    setComposerAttachments(attachments);
  };

  const clearComposerAttachments = (): void => {
    releaseComposerAttachments(composerAttachmentsRef.current);
    overwriteComposerAttachments([]);
  };

  const removeComposerAttachment = (attachmentId: string): void => {
    const current = composerAttachmentsRef.current;
    const removed = current.find(
      (attachment) => attachment.attachment.attachmentId === attachmentId
    );
    if (!removed) {
      return;
    }
    releaseComposerAttachments([removed]);
    overwriteComposerAttachments(
      current.filter(
        (attachment) => attachment.attachment.attachmentId !== attachmentId
      )
    );
  };

  const appendComposerAttachments = async (
    files: Iterable<File>,
    origin: "picker" | "drop" | "paste"
  ): Promise<void> => {
    if (isComposerBusy) {
      return;
    }
    const nextAttachments = await createComposerAttachments(files, origin);
    if (!mountedRef.current) {
      releaseComposerAttachments(nextAttachments);
      return;
    }
    if (nextAttachments.length === 0) {
      return;
    }
    const merged = mergeComposerAttachments(
      composerAttachmentsRef.current,
      nextAttachments
    );
    releaseComposerAttachments(merged.skipped);
    overwriteComposerAttachments(merged.attachments);
  };

  const onComposerInputChange = (
    event: ReactChangeEvent<HTMLInputElement>
  ): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0 || isComposerBusy) {
      return;
    }
    void appendComposerAttachments(files, "picker").catch((error) => {
      setStatusNotice({
        message: `Attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send"
      });
    });
  };

  const onComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    if (isComposerBusy) {
      return;
    }
    const files = collectPastedImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    if (!hasStringTransfer(event.clipboardData)) {
      event.preventDefault();
    }
    void appendComposerAttachments(files, "paste").catch((error) => {
      setStatusNotice({
        message: `Paste attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send"
      });
    });
  };

  const onComposerDragEnter = (
    event: ReactDragEvent<HTMLElement>
  ): void => {
    if (!hasFileTransfer(event.dataTransfer) || isComposerBusy) {
      return;
    }
    event.preventDefault();
    composerDropDepthRef.current += 1;
    setIsComposerDropTarget(true);
  };

  const onComposerDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer) || isComposerBusy) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isComposerDropTarget) {
      setIsComposerDropTarget(true);
    }
  };

  const onComposerDragLeave = (
    event: ReactDragEvent<HTMLElement>
  ): void => {
    if (!hasFileTransfer(event.dataTransfer) || isComposerBusy) {
      return;
    }
    event.preventDefault();
    composerDropDepthRef.current = Math.max(0, composerDropDepthRef.current - 1);
    if (composerDropDepthRef.current === 0) {
      setIsComposerDropTarget(false);
    }
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFileTransfer(event.dataTransfer) || isComposerBusy) {
      return;
    }
    event.preventDefault();
    composerDropDepthRef.current = 0;
    setIsComposerDropTarget(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }
    void appendComposerAttachments(files, "drop").catch((error) => {
      setStatusNotice({
        message: `Drop attachment failed: ${(error as Error).message}`,
        persistent: true,
        source: "send"
      });
    });
  };

  const onSend = async (): Promise<void> => {
    const text = draft.trim();
    const attachments = composerAttachmentsRef.current.map(
      (attachment) => attachment.attachment
    );
    if (
      isSendingComposer ||
      (!text && attachments.length === 0) ||
      !activeSessionId ||
      !transport
    ) {
      return;
    }
    setIsSendingComposer(true);
    setStatusNotice({
      message: "Sending…",
      persistent: true,
      source: "send"
    });
    try {
      await transport.chat.send({
        sessionId: activeSessionId,
        content: text,
        attachments
      });
      setDraft("");
      clearComposerAttachments();
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
    } finally {
      setIsSendingComposer(false);
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

  const onToggleProcess = (turnId: string): void => {
    const row = renderedTranscriptRows.find((candidate) => candidate.turn.turnId === turnId);
    if (!row) {
      return;
    }
    setProcessVisibilityByTurnId((current) =>
      toggleProcessVisibility(current, turnId, row.defaultProcessExpanded)
    );
  };

  const onActivateResourceLink = (reference: ExtractedFileReference): void => {
    setDetailTab("files");
    fileBrowser.selectFile(reference);
  };

  const onPreviewImage = (image: ImageLightboxState): void => {
    setLightboxImage(image);
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
                        void onCreateSession(workspace.workspaceId, selectedEngineId);
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
              currentEngineId={selectedEngineId}
              transport={transport}
              onEngineSaved={setSelectedEngineId}
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
              transport={transport}
              engineId={displayedEngineId}
              engineSurface={displayedEngineId ? engineSurfacesById[displayedEngineId] : undefined}
              activeSessionWindow={activeSessionWindow}
              activeSessionId={activeSessionId}
              isOpeningSelectedSession={isOpeningSelectedSession}
              loadingOlderTurns={loadingOlderTurns}
              onLoadOlder={() => void onLoadOlder()}
              processVisibilityByTurnId={processVisibilityByTurnId}
              onToggleProcess={onToggleProcess}
              onActivateResourceLink={onActivateResourceLink}
              onPreviewImage={onPreviewImage}
              onRespondApproval={transport ? onRespondApproval : undefined}
            />
          </div>

          <footer
            className={`awb-composer${isComposerDropTarget ? " is-drop-target" : ""}`}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <input
              ref={composerFileInputRef}
              className="awb-composer__file-input"
              type="file"
              multiple
              onChange={onComposerInputChange}
            />
            {composerAttachments.length > 0 ? (
              <div className="awb-composer__attachments" aria-label="Composer attachments">
                {composerAttachments.map((attachment) => (
                  <article
                    key={attachment.attachment.attachmentId}
                    className="awb-composer__attachment"
                  >
                    {attachment.previewUrl ? (
                      <img
                        className="awb-composer__attachment-preview"
                        src={attachment.previewUrl}
                        alt={attachment.displayName}
                      />
                    ) : (
                      <div className="awb-composer__attachment-icon" aria-hidden="true">
                        FILE
                      </div>
                    )}
                    <div className="awb-composer__attachment-copy">
                      <strong>{attachment.displayName}</strong>
                      <span>
                        {attachment.mimeType} · {attachment.sizeLabel}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="awb-ghost-button awb-composer__attachment-remove"
                      onClick={() =>
                        removeComposerAttachment(attachment.attachment.attachmentId)
                      }
                      aria-label={`Remove ${attachment.displayName}`}
                    >
                      Remove
                    </button>
                  </article>
                ))}
              </div>
            ) : null}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={onComposerPaste}
              placeholder="Message the active session, paste images, or drop files here..."
              disabled={isComposerBusy}
            />
            <div className="awb-composer__actions">
              <span className="awb-status">{status}</span>
              <div className="awb-composer__buttons">
                <button
                  type="button"
                  className="awb-ghost-button"
                  onClick={() => composerFileInputRef.current?.click()}
                  disabled={isComposerBusy}
                >
                  Attach files
                </button>
                <button
                  type="button"
                  onClick={() => void onSend()}
                  disabled={!canSendComposerPayload}
                >
                  Send
                </button>
              </div>
            </div>
          </footer>
        </main>

        <aside className="awb-shell__detail" aria-label="Session details">
          <div className="awb-detail__tabs" role="tablist" aria-label="Detail tabs">
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === "graph"}
              className={detailTab === "graph" ? "is-active" : ""}
              onClick={() => setDetailTab("graph")}
            >
              Graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === "files"}
              className={detailTab === "files" ? "is-active" : ""}
              onClick={() => setDetailTab("files")}
            >
              Files
            </button>
          </div>
          {detailTab === "graph" ? (
            <section className="awb-detail__graph">
              <ChatTreePanel
                chatTree={activeChatTree}
                onJump={transport ? (nodeId) => void onJumpChatTree(nodeId) : undefined}
              />
            </section>
          ) : (
            <FilesDetailPanel
              workspaceLabel={activeWorkspace?.label}
              hasWorkspace={Boolean(activeWorkspace?.workspaceId)}
              query={fileBrowser.query}
              onQueryChange={(value) => {
                setDetailTab("files");
                fileBrowser.setQuery(value);
              }}
              isSearching={fileBrowser.isSearching}
              searchResults={fileBrowser.searchResults}
              selectedFile={fileBrowser.selectedFile}
              preview={fileBrowser.preview}
              isLoadingPreview={fileBrowser.isLoadingPreview}
              onSelectFile={(reference) => {
                setDetailTab("files");
                fileBrowser.selectFile(reference);
              }}
              onRunFileAction={(input) => void fileBrowser.runFileAction(input)}
              onOpenImage={onPreviewImage}
            />
          )}
        </aside>
      </div>
      {sessionMenuMarkup &&
        (typeof document === "undefined"
          ? sessionMenuMarkup
          : createPortal(sessionMenuMarkup, document.body))}
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
};
