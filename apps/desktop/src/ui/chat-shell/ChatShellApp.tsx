import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject,
  type SetStateAction
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentParticipant,
  ApprovalRequest,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  ExtractedFileReference,
  RuntimeInteraction,
  SchedulerTaskDocumentRpc,
  SchedulerTaskScheduleRpc,
  Turn,
  SessionWindowRpc,
  TakeoverSessionStateRpc,
  TakeoverPresetSummaryRpc
} from "@another-workbench/shared";
import "xterm/css/xterm.css";
import type { RendererStore } from "../../store/store.js";
import type {
  DesktopTransport,
  EventBacklogPressure
} from "../../transport/desktop-transport.js";
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
import { buildParticipantDirectory } from "./participant-directory.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";
import { filterTranscriptRowsForChatTree } from "./chat-tree-transcript.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import { useFileBrowserController } from "./use-file-browser-controller.js";
import {
  useRendererConversationRevision,
  useRendererSessionRevision,
  useRendererStoreState
} from "./use-renderer-store-state.js";
import {
  findActiveSessionNode,
  findSessionNode,
  type SessionBrowserViewNode,
  type WorkspaceBrowserViewNode
} from "./workspace-browser-tree.js";
import { useTranscriptViewportController } from "./use-transcript-viewport-controller.js";
import { useWorkspaceBrowserController } from "./use-workspace-browser-controller.js";
import { useSessionOpenController } from "./use-session-open-controller.js";
import type { SessionWindowCoverage } from "./use-session-open-controller.js";
import {
  shouldDismissFloatingMenuForContextMenu,
  useSessionActionsController,
  type SessionMenuState
} from "./use-session-actions-controller.js";
import {
  openWorkspaceDirectory,
  workspaceDirectoryActionLabel
} from "./workspace-actions.js";
import { useChatTreeController } from "./use-chat-tree-controller.js";
import { useRendererDiagnostics } from "./use-renderer-diagnostics.js";
import { buildEngineInspectorViewModel } from "./engine-summary.js";
import { resolveAutoRefreshBacklogAttempt } from "./auto-refresh-backlog.js";
import { ComposerContainer } from "./composer/ComposerContainer.js";
import {
  beginTakeoverStateRequest,
  canCommitTakeoverStateRequest,
  createTakeoverStateRequestState,
  finishTakeoverStateRequest,
  invalidateTakeoverStateRequestsForSession,
  resetTakeoverStateRequests,
  resolveCurrentTakeoverState
} from "./takeover-state-controller.js";
import "./chat-shell.css";

export { resolveCurrentTakeoverState } from "./takeover-state-controller.js";

type SettingsLauncherProps = {
  engines: EngineDefinitionRpc[];
  surfacesByEngineId: Readonly<Record<string, EngineSurfaceRpc | undefined>>;
  currentEngineId: string;
  transport?: DesktopTransport;
  onEngineSaved: (engineId: string) => void;
  onTakeoverPresetsChanged: (presets: TakeoverPresetSummaryRpc[]) => void;
  onStatusNotice: (notice: ComposerStatusNotice) => void;
};

type SettingsTab = "general" | "takeover";

const takeoverPresetNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const autoRefreshBacklogCooldownMs = 30_000;
const autoRefreshBacklogStreamThreshold = 500;

const createDefaultTakeoverPresetPrompt = (presetId: string): string => `# ${presetId}

Use this takeover preset to describe the role, inspection scope, and verdict standard.
`;

type TranscriptPaneProps = {
  transcriptRef: RefObject<HTMLElement | null>;
  transcriptContentRef: RefObject<HTMLDivElement | null>;
  renderedTranscriptRows: ReturnType<typeof buildTurnTranscriptRows>;
  participantDirectory: ReturnType<typeof buildParticipantDirectory>;
  transport?: DesktopTransport;
  engineId?: string;
  engineSurface?: EngineSurfaceRpc;
  engineExtensionRefreshSignal: number;
  activeSessionWindow?: Omit<SessionWindowRpc, "snapshot">;
  activeSessionId?: string;
  isOpeningSelectedSession: boolean;
  loadingOlderTurns: boolean;
  onLoadOlder: () => void;
  processVisibilityByTurnId: Readonly<Record<string, ProcessVisibilityOverride>>;
  onToggleProcess: (turnId: string, defaultExpanded: boolean) => void;
  onActivateResourceLink: (reference: ExtractedFileReference) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
    decision?: string | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  onRespondInteraction?: (input: {
    sessionId: string;
    requestId: string;
    action: "accept" | "decline" | "cancel" | "submit" | "defer";
    response?: Record<string, unknown>;
    content?: unknown;
    answers?: Record<string, string[]>;
  }) => Promise<void>;
};

type DetailTab = "graph" | "files";
type TranscriptRow = ReturnType<typeof buildTurnTranscriptRows>[number];
type RenderedTurnGroup = {
  visibleRow: TranscriptRow;
  hiddenRows: TranscriptRow[];
};
type WorkspaceMenuAction = "open_directory" | "remove_workspace" | "schedule";
type WorkspaceMenuState = {
  workspaceId: string;
  label: string;
  rootPath: string;
  x: number;
  y: number;
  actions: WorkspaceMenuAction[];
};

const emptyTurns: Turn[] = [];
const emptyParticipants: AgentParticipant[] = [];
const weekDayOptions = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" }
] as const;
const monthDayOptions = Array.from({ length: 31 }, (_, index) => index + 1);

const resolveFloatingMenuViewportStyle = (input: {
  x: number;
  y: number;
  itemCount: number;
}): CSSProperties => {
  const estimatedWidth = 188;
  const estimatedHeight = input.itemCount * 37 + 8;
  const gutter = 8;
  if (typeof window === "undefined") {
    return {
      left: input.x,
      top: input.y
    };
  }
  const maxLeft = Math.max(gutter, window.innerWidth - estimatedWidth - gutter);
  const maxTop = Math.max(gutter, window.innerHeight - estimatedHeight - gutter);
  return {
    left: Math.min(input.x, maxLeft),
    top: Math.min(input.y, maxTop)
  };
};

const resolveSessionMenuViewportStyle = (
  sessionMenu: SessionMenuState
): CSSProperties =>
  resolveFloatingMenuViewportStyle({
    x: sessionMenu.x,
    y: sessionMenu.y,
    itemCount: sessionMenu.actions.length
  });

const resolveWorkspaceMenuViewportStyle = (
  workspaceMenu: WorkspaceMenuState
): CSSProperties =>
  resolveFloatingMenuViewportStyle({
    x: workspaceMenu.x,
    y: workspaceMenu.y,
    itemCount: workspaceMenu.actions.length
  });

export type ChatShellAppProps = {
  store: RendererStore;
  transport?: DesktopTransport;
  title?: string;
};

const uniqueByEngineId = (
  engines: Array<EngineDefinitionRpc | undefined>
): EngineDefinitionRpc[] => {
  const seen = new Set<string>();
  const result: EngineDefinitionRpc[] = [];
  for (const engine of engines) {
    if (!engine || seen.has(engine.engineId)) {
      continue;
    }
    seen.add(engine.engineId);
    result.push(engine);
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

const maxSessionHeadingLength = 20;
const workspaceSessionPageSize = 10;

export const truncateSessionHeading = (value: string | undefined): string => {
  const normalized = value?.trim();
  if (!normalized) {
    return "Thread";
  }
  if (normalized.length <= maxSessionHeadingLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxSessionHeadingLength)}…`;
};

export const formatRelativeCompletedTurnAge = (
  iso: string | undefined,
  nowMs = Date.now()
): string | undefined => {
  if (!iso) {
    return undefined;
  }
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - timestamp) / 60_000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }
  return `${Math.floor(elapsedHours / 24)}d`;
};

export const getWorkspaceSessionPage = <Session,>(
  sessions: readonly Session[],
  pageIndex: number
): {
  pageIndex: number;
  totalPages: number;
  sessions: Session[];
} => {
  const totalPages = Math.max(1, Math.ceil(sessions.length / workspaceSessionPageSize));
  const normalizedPageIndex = Math.min(
    Math.max(0, pageIndex),
    totalPages - 1
  );
  const startIndex = normalizedPageIndex * workspaceSessionPageSize;
  return {
    pageIndex: normalizedPageIndex,
    totalPages,
    sessions: sessions.slice(startIndex, startIndex + workspaceSessionPageSize)
  };
};

const buildWorkspaceEngineFallbacks = (
  workspaces: WorkspaceBrowserViewNode[]
): EngineDefinitionRpc[] => {
  const engineIds = new Set<string>();
  for (const workspace of workspaces) {
    const stack = [...workspace.sessions];
    while (stack.length > 0) {
      const session = stack.pop();
      if (!session || engineIds.has(session.engineId)) {
        continue;
      }
      engineIds.add(session.engineId);
      stack.push(...session.children);
    }
  }

  return [...engineIds].map((engineId) => ({
    engineId,
    displayName: engineId,
    integrationTier: "fallback",
    transportKind: undefined
  }));
};

const resolveStatusDotLabel = (
  statusDot: SessionBrowserViewNode["statusDot"]
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

export const workspaceMenuActionLabel = (
  action: WorkspaceMenuAction
): string => {
  switch (action) {
    case "open_directory":
      return workspaceDirectoryActionLabel;
    case "remove_workspace":
      return "Remove workspace";
    case "schedule":
      return "Schedule";
  }
};

const summarizeProcessToggle = (input: {
  hiddenMessageCount?: number;
  toolCount: number;
  terminalCount: number;
  approvalCount: number;
}): string => {
  const parts: string[] = [];
  if (input.hiddenMessageCount && input.hiddenMessageCount > 0) {
    parts.push(
      `${input.hiddenMessageCount} earlier message${
        input.hiddenMessageCount === 1 ? "" : "s"
      }`
    );
  }
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

const countHiddenMessages = (rows: TranscriptRow[]): number => {
  const messageIds = new Set<string>();
  for (const row of rows) {
    for (const block of row.blocks) {
      messageIds.add(block.messageId);
    }
  }
  return messageIds.size;
};

const buildTranscriptContentVersion = (rows: TranscriptRow[]): string =>
  rows
    .map((row) =>
      [
        row.rowId,
        row.turn.status,
        row.turn.completedAt ?? "",
        row.blocks
          .map(
            (block) =>
              `${block.blockId}:${block.kind}:${block.text?.length ?? 0}:${
                block.startedAt ?? ""
              }`
          )
          .join(","),
        row.toolCalls
          .map(
            (toolCall) =>
              `${toolCall.toolCallId}:${toolCall.status}:${
                toolCall.inputSummary?.length ?? 0
              }:${toolCall.outputSummary?.length ?? 0}`
          )
          .join(","),
        row.terminalStreams
          .map(
            (stream) =>
              `${stream.terminalId}:${stream.status}:${stream.outputText.length}:${
                stream.exitCode ?? ""
              }`
          )
          .join(","),
        row.approvals
          .map((approval) => `${approval.requestId}:${approval.status}`)
          .join(",")
      ].join("|")
    )
    .join("||");

const buildRenderedTurnGroups = (
  rows: ReturnType<typeof buildTurnTranscriptRows>
): RenderedTurnGroup[] => {
  const groups: RenderedTurnGroup[] = [];

  for (let index = 0; index < rows.length; ) {
    const turnId = rows[index]!.turn.turnId;
    const turnRows: TranscriptRow[] = [];
    while (index < rows.length && rows[index]!.turn.turnId === turnId) {
      turnRows.push(rows[index]!);
      index += 1;
    }

    const turn = turnRows[0]!.turn;
    if (turn.status !== "completed") {
      groups.push(
        ...turnRows.map((row) => ({
          visibleRow: row,
          hiddenRows: []
        }))
      );
      continue;
    }

    const visibleRow =
      turnRows.find((row) => row.isFinalResponseRow) ??
      turnRows.find((row) => row.canDisplayAsFinalResponse) ??
      turnRows.at(-1) ??
      turnRows[0]!;
    const hiddenRows = turnRows.filter(
      (row) => row.rowId !== visibleRow.rowId && row.messageRole !== "user"
    );

    for (const row of turnRows) {
      if (row.rowId === visibleRow.rowId) {
        groups.push({
          visibleRow,
          hiddenRows
        });
        continue;
      }
      if (row.messageRole === "user") {
        groups.push({
          visibleRow: row,
          hiddenRows: []
        });
      }
    }
  }

  return groups;
};

const resolveProcessOutputToggleLabel = (expanded: boolean): string =>
  expanded ? "Hide process output" : "Show process output";

const formatPreviousMessagesLabel = (count: number): string =>
  `${count} previous message${count === 1 ? "" : "s"} >`;

const TranscriptPane = memo(
  ({
    transcriptRef,
    transcriptContentRef,
    renderedTranscriptRows,
    participantDirectory,
    transport,
    engineId,
    engineSurface,
    engineExtensionRefreshSignal,
    activeSessionWindow,
    activeSessionId,
    isOpeningSelectedSession,
    loadingOlderTurns,
    onLoadOlder,
    processVisibilityByTurnId,
    onToggleProcess,
    onActivateResourceLink,
    onPreviewImage,
    onRespondApproval,
    onRespondInteraction
  }: TranscriptPaneProps): ReactElement => (
    <section
      className="awb-transcript"
      ref={transcriptRef}
      role="region"
      aria-label="Transcript"
      tabIndex={0}
    >
      <div className="awb-transcript__content" ref={transcriptContentRef}>
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

        {buildRenderedTurnGroups(renderedTranscriptRows).map(({ visibleRow, hiddenRows }, index, groups) => {
          const isUserTurn = visibleRow.messageRole === "user";
          const isInlineProcessRow =
            visibleRow.rowKind === "process" && visibleRow.turn.status !== "completed";
          const nextGroup = groups[index + 1];
          const isFollowedBySameTurn =
            nextGroup?.visibleRow.turn.turnId === visibleRow.turn.turnId;
          const hiddenMessageCount = countHiddenMessages(hiddenRows);
          const hasCollapsedContent = hiddenRows.length > 0;
          const hasExpandableDetails =
            !isUserTurn &&
            !isInlineProcessRow &&
            (visibleRow.hasProcessDetails || hasCollapsedContent);
          const defaultExpanded = hasCollapsedContent
            ? false
            : visibleRow.defaultProcessExpanded;
          const isProcessExpanded =
            hasExpandableDetails &&
            resolveProcessExpanded(
              defaultExpanded,
              processVisibilityByTurnId[visibleRow.turn.turnId]
            );
          const processSummary = summarizeProcessToggle({
            hiddenMessageCount,
            toolCount: visibleRow.toolCalls.length,
            terminalCount: visibleRow.terminalStreams.length,
            approvalCount: visibleRow.approvals.length
          });
          const processToggleLabel = resolveProcessOutputToggleLabel(isProcessExpanded);
          const previousMessagesLabel = formatPreviousMessagesLabel(hiddenMessageCount);
          const isFinalDisplayedAssistantRow =
            !isUserTurn && visibleRow.turn.status === "completed" && !isInlineProcessRow;
          const shouldShowTimestamp = isUserTurn || isFinalDisplayedAssistantRow;
          const shouldRenderExtensions = isFinalDisplayedAssistantRow;
          return (
            <article
              key={visibleRow.rowId}
              data-turn-id={visibleRow.turn.turnId}
              data-final-response-row={visibleRow.isFinalResponseRow ? "true" : "false"}
              className={`awb-chat-entry ${isUserTurn ? "is-user" : "is-assistant"} ${
                isFollowedBySameTurn ? "is-followed-by-same-turn" : ""
              }`}
            >
              {shouldShowTimestamp && (
                <header className="awb-chat-entry__identity">
                  <time className="awb-chat-entry__timestamp">
                    {formatTimestamp(
                      visibleRow.startedAt ??
                        visibleRow.turn.completedAt ??
                        visibleRow.turn.startedAt
                    )}
                  </time>
                </header>
              )}
              {hasExpandableDetails && (
                <div
                  className={`awb-turn__process ${
                    hasCollapsedContent ? "awb-turn__process--history" : ""
                  }`}
                >
                  <button
                    type="button"
                    className={`awb-turn__process-toggle ${
                      hasCollapsedContent ? "is-history-divider" : ""
                    }`}
                    onClick={() => onToggleProcess(visibleRow.turn.turnId, defaultExpanded)}
                    aria-expanded={isProcessExpanded}
                  >
                    {hasCollapsedContent ? (
                      <>
                        <span aria-hidden="true" />
                        <span>{previousMessagesLabel}</span>
                        <span aria-hidden="true" />
                      </>
                    ) : (
                      <>
                        <span>{processToggleLabel}</span>
                        <span>{processSummary}</span>
                      </>
                    )}
                  </button>
                  {isProcessExpanded && (
                    <TurnProcessPanel
                      row={visibleRow}
                      hiddenRows={hiddenRows}
                      participantDirectory={participantDirectory}
                      onActivateResourceLink={onActivateResourceLink}
                      onPreviewImage={onPreviewImage}
                      onRespondApproval={onRespondApproval}
                      onRespondInteraction={onRespondInteraction}
                    />
                  )}
                </div>
              )}
              {isInlineProcessRow && (
                <div className="awb-turn__process awb-turn__process--inline">
                  <TurnProcessPanel
                    row={visibleRow}
                    hiddenRows={[]}
                    participantDirectory={participantDirectory}
                    onActivateResourceLink={onActivateResourceLink}
                    onPreviewImage={onPreviewImage}
                    onRespondApproval={onRespondApproval}
                    onRespondInteraction={onRespondInteraction}
                  />
                </div>
              )}
              {!isInlineProcessRow && (
                <div className="awb-chat-entry__messages">
                  {visibleRow.blocks.length === 0 && (
                    <p className="awb-turn__empty">
                      {isUserTurn ? "No message content." : "Waiting for response…"}
                    </p>
                  )}
                  {visibleRow.blocks.map((block) => (
                    <MessageMarkdownView
                      key={block.blockId}
                      block={block}
                      onActivateResourceLink={onActivateResourceLink}
                      onPreviewImage={onPreviewImage}
                    />
                  ))}
                </div>
              )}
              {shouldRenderExtensions
                ? renderTurnExtensions({
                    transport,
                    engineId,
                    engineSurface,
                    sessionId: visibleRow.turn.sessionId,
                    turnId: visibleRow.turn.turnId,
                    refreshSignal: engineExtensionRefreshSignal
                  })
                : null}
            </article>
          );
        })}
      </div>
    </section>
  ),
  (previous, next) =>
    previous.renderedTranscriptRows === next.renderedTranscriptRows &&
    previous.participantDirectory === next.participantDirectory &&
    previous.transport === next.transport &&
    previous.engineId === next.engineId &&
    previous.engineSurface === next.engineSurface &&
    previous.engineExtensionRefreshSignal === next.engineExtensionRefreshSignal &&
    previous.activeSessionWindow === next.activeSessionWindow &&
    previous.activeSessionId === next.activeSessionId &&
    previous.isOpeningSelectedSession === next.isOpeningSelectedSession &&
    previous.loadingOlderTurns === next.loadingOlderTurns &&
    previous.processVisibilityByTurnId === next.processVisibilityByTurnId &&
    previous.transcriptRef === next.transcriptRef &&
    previous.transcriptContentRef === next.transcriptContentRef &&
    previous.onActivateResourceLink === next.onActivateResourceLink &&
    previous.onPreviewImage === next.onPreviewImage
);

const SettingsLauncher = ({
  engines,
  surfacesByEngineId,
  currentEngineId,
  transport,
  onEngineSaved,
  onTakeoverPresetsChanged,
  onStatusNotice
}: SettingsLauncherProps): ReactElement => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTab>("general");
  const [draftEngineId, setDraftEngineId] = useState(currentEngineId);
  const [isSaving, setIsSaving] = useState(false);
  const [takeoverRootPath, setTakeoverRootPath] = useState("");
  const [takeoverPresets, setTakeoverPresets] = useState<
    TakeoverPresetSummaryRpc[]
  >([]);
  const [selectedTakeoverPresetId, setSelectedTakeoverPresetId] =
    useState<string>("");
  const [draftTakeoverPresetId, setDraftTakeoverPresetId] = useState("");
  const [draftTakeoverPrompt, setDraftTakeoverPrompt] = useState("");
  const [isLoadingTakeoverPresets, setIsLoadingTakeoverPresets] =
    useState(false);
  const [isSavingTakeoverPreset, setIsSavingTakeoverPreset] = useState(false);
  const takeoverPresetReadRequestId = useRef(0);
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

  const readTakeoverPreset = useCallback(
    async (presetId: string): Promise<void> => {
      if (!transport || !presetId) {
        return;
      }
      const requestId = ++takeoverPresetReadRequestId.current;
      const preset = await transport.takeoverPresets.read(presetId);
      if (requestId !== takeoverPresetReadRequestId.current) {
        return;
      }
      setSelectedTakeoverPresetId(preset.presetId);
      setDraftTakeoverPresetId(preset.presetId);
      setDraftTakeoverPrompt(preset.prompt);
    },
    [transport]
  );

  const loadTakeoverPresets = useCallback(
    async (selectPresetId?: string): Promise<void> => {
      if (!transport) {
        return;
      }
      setIsLoadingTakeoverPresets(true);
      try {
        const result = await transport.takeoverPresets.list();
        setTakeoverRootPath(result.rootPath);
        setTakeoverPresets(result.presets);
        onTakeoverPresetsChanged(result.presets);
        const requestedPresetId =
          selectPresetId !== undefined ? selectPresetId : selectedTakeoverPresetId;
        const nextPresetId =
          result.presets.find((preset) => preset.presetId === requestedPresetId)
            ?.presetId ||
          result.presets[0]?.presetId ||
          "";
        if (nextPresetId) {
          await readTakeoverPreset(nextPresetId);
        } else {
          setSelectedTakeoverPresetId("");
          setDraftTakeoverPresetId("");
          setDraftTakeoverPrompt("");
        }
      } catch (error) {
        onStatusNotice({
          message: `Takeover presets load failed: ${(error as Error).message}`,
          persistent: true,
          source: "settings",
          ...statusNoticeErrorDetails(error)
        });
      } finally {
        setIsLoadingTakeoverPresets(false);
      }
    },
    [
      onStatusNotice,
      onTakeoverPresetsChanged,
      readTakeoverPreset,
      selectedTakeoverPresetId,
      transport
    ]
  );

  useEffect(() => {
    if (isOpen && activeSettingsTab === "takeover" && transport) {
      void loadTakeoverPresets();
    }
  }, [activeSettingsTab, isOpen, loadTakeoverPresets, transport]);

  const close = (): void => {
    setIsOpen(false);
  };

  const open = (): void => {
    setDraftEngineId(currentEngineId);
    setActiveSettingsTab("general");
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
        source: "settings",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSaving(false);
    }
  };

  const onSelectTakeoverPreset = async (presetId: string): Promise<void> => {
    try {
      await readTakeoverPreset(presetId);
    } catch (error) {
      onStatusNotice({
        message: `Preset load failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings",
        ...statusNoticeErrorDetails(error)
      });
    }
  };

  const onNewTakeoverPreset = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    const existingPresetIds = new Set(
      takeoverPresets.map((preset) => preset.presetId)
    );
    const basePresetId = "custom-preset";
    let presetId = basePresetId;
    let index = 2;
    while (existingPresetIds.has(presetId)) {
      presetId = `${basePresetId}-${index}`;
      index += 1;
    }
    setIsSavingTakeoverPreset(true);
    try {
      const preset = await transport.takeoverPresets.upsert({
        presetId,
        prompt: createDefaultTakeoverPresetPrompt(presetId)
      });
      await loadTakeoverPresets(preset.presetId);
      onStatusNotice({
        message: `Takeover preset created: ${preset.presetId}`,
        source: "settings"
      });
    } catch (error) {
      onStatusNotice({
        message: `Preset create failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSavingTakeoverPreset(false);
    }
  };

  const onSaveTakeoverPreset = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    const presetId = draftTakeoverPresetId.trim();
    if (!takeoverPresetNamePattern.test(presetId)) {
      onStatusNotice({
        message:
          "Preset names must start with a letter or number and may only contain letters, numbers, underscores, and hyphens.",
        persistent: true,
        source: "settings"
      });
      return;
    }
    setIsSavingTakeoverPreset(true);
    try {
      const preset = await transport.takeoverPresets.upsert({
        presetId,
        prompt: draftTakeoverPrompt
      });
      await loadTakeoverPresets(preset.presetId);
      onStatusNotice({
        message: `Takeover preset saved: ${preset.presetId}`,
        source: "settings"
      });
    } catch (error) {
      onStatusNotice({
        message: `Preset save failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSavingTakeoverPreset(false);
    }
  };

  const onDeleteTakeoverPreset = async (): Promise<void> => {
    if (!transport || !selectedTakeoverPresetId) {
      return;
    }
    setIsSavingTakeoverPreset(true);
    try {
      const result = await transport.takeoverPresets.delete(
        selectedTakeoverPresetId
      );
      await loadTakeoverPresets("");
      onStatusNotice({
        message: result.deleted
          ? `Takeover preset deleted: ${result.presetId}`
          : `Takeover preset not found: ${result.presetId}`,
        source: "settings"
      });
    } catch (error) {
      onStatusNotice({
        message: `Preset delete failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSavingTakeoverPreset(false);
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
        <div className="awb-modal__body awb-settings">
          <div className="awb-settings__tabs" role="tablist" aria-label="Settings">
            <button
              type="button"
              role="tab"
              aria-selected={activeSettingsTab === "general"}
              className={activeSettingsTab === "general" ? "is-active" : undefined}
              onClick={() => setActiveSettingsTab("general")}
            >
              General
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeSettingsTab === "takeover"}
              className={activeSettingsTab === "takeover" ? "is-active" : undefined}
              onClick={() => setActiveSettingsTab("takeover")}
            >
              Takeover
            </button>
          </div>
          {activeSettingsTab === "general" ? (
            <div className="awb-settings__panel" role="tabpanel">
              <label className="awb-field">
                <span>New session engine</span>
                <select
                  value={draftEngineId}
                  onChange={(event) => setDraftEngineId(event.target.value)}
                >
                  <option value="">Follow first available engine</option>
                  {engines.map((engine) => (
                    <option key={engine.engineId} value={engine.engineId}>
                      {tierByEngineId[engine.engineId]
                        ? `${engine.displayName} (${tierByEngineId[engine.engineId]})`
                        : engine.displayName}
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
          ) : (
            <div className="awb-settings__panel" role="tabpanel">
              <div className="awb-takeover-presets">
                <div className="awb-takeover-presets__header">
                  <span>Preset directory</span>
                  <code title={takeoverRootPath || "Takeover presets"}>
                    {takeoverRootPath || "Takeover presets"}
                  </code>
                </div>
                <div className="awb-takeover-presets__content">
                  <div className="awb-takeover-presets__list">
                    <div className="awb-takeover-presets__bar">
                      <span>Presets</span>
                      <button
                        type="button"
                        className="awb-secondary-button awb-secondary-button--small"
                        onClick={() => void onNewTakeoverPreset()}
                        disabled={isLoadingTakeoverPresets || isSavingTakeoverPreset}
                      >
                        New
                      </button>
                    </div>
                    <div className="awb-takeover-presets__items">
                      {takeoverPresets.map((preset) => (
                        <button
                          type="button"
                          key={preset.presetId}
                          className={
                            preset.presetId === selectedTakeoverPresetId
                              ? "is-active"
                              : undefined
                          }
                          onClick={() => void onSelectTakeoverPreset(preset.presetId)}
                        >
                          <strong>{preset.displayName}</strong>
                          <span>{preset.presetId}</span>
                        </button>
                      ))}
                      {takeoverPresets.length === 0 && (
                        <span className="awb-takeover-presets__empty">
                          {isLoadingTakeoverPresets ? "Loading..." : "No presets"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="awb-takeover-presets__editor">
                    <label className="awb-field">
                      <span>Preset name</span>
                      <input
                        value={draftTakeoverPresetId}
                        onChange={(event) =>
                          setDraftTakeoverPresetId(event.target.value)
                        }
                        spellCheck={false}
                      />
                    </label>
                    <label className="awb-field awb-field--takeover-prompt">
                      <span>Prompt</span>
                      <textarea
                        value={draftTakeoverPrompt}
                        onChange={(event) =>
                          setDraftTakeoverPrompt(event.target.value)
                        }
                        spellCheck={false}
                      />
                    </label>
                    <div className="awb-takeover-presets__actions">
                      <button
                        type="button"
                        className="awb-ghost-button"
                        onClick={() => void onDeleteTakeoverPreset()}
                        disabled={!selectedTakeoverPresetId || isSavingTakeoverPreset}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="awb-secondary-button"
                        onClick={() => void onSaveTakeoverPreset()}
                        disabled={isSavingTakeoverPreset}
                      >
                        Save preset
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <footer className="awb-modal__footer">
          <button type="button" className="awb-ghost-button" onClick={close}>
            {activeSettingsTab === "general" ? "Cancel" : "Close"}
          </button>
          {activeSettingsTab === "general" && (
            <button
              type="button"
              className="awb-secondary-button"
              onClick={() => void onSave()}
              disabled={isSaving}
            >
              Save
            </button>
          )}
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

type ScheduleWorkspaceTarget = {
  workspaceId: string;
  label: string;
  rootPath: string;
};

type ScheduleDraft = {
  taskId?: string;
  name: string;
  enabled: boolean;
  scheduleKind: SchedulerTaskScheduleRpc["kind"];
  runAt: string;
  time: string;
  everyMinutes: string;
  daysOfWeek: number[];
  daysOfMonth: number[];
  startDate: string;
  endDate: string;
  prompt: string;
};

type ScheduleWorkspaceModalProps = {
  workspace: ScheduleWorkspaceTarget;
  transport?: DesktopTransport;
  onClose: () => void;
  onStatusNotice: (notice: ComposerStatusNotice) => void;
};

const localTodayDateValue = (): string => {
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const nextHourDateTimeValue = (): string => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return formatLocalDateTimeInputValue(date);
};

const formatLocalDateTimeInputValue = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

const isoToLocalDateTimeInputValue = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return nextHourDateTimeValue();
  }
  return formatLocalDateTimeInputValue(date);
};

const formatLocalDateTimeSummary = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
};

const createEmptyScheduleDraft = (
  workspace: ScheduleWorkspaceTarget
): ScheduleDraft => ({
  name: `${workspace.label} scheduled task`,
  enabled: true,
  scheduleKind: "daily",
  runAt: nextHourDateTimeValue(),
  time: "09:00",
  everyMinutes: "60",
  daysOfWeek: [1],
  daysOfMonth: [1],
  startDate: localTodayDateValue(),
  endDate: "",
  prompt: ""
});

const draftFromTask = (task: SchedulerTaskDocumentRpc): ScheduleDraft => {
  const schedule = task.schedule;
  return {
    taskId: task.id,
    name: task.name,
    enabled: task.enabled,
    scheduleKind: schedule.kind,
    runAt:
      schedule.kind === "once"
        ? isoToLocalDateTimeInputValue(schedule.runAt)
        : nextHourDateTimeValue(),
    time:
      schedule.kind === "daily" ||
      schedule.kind === "weekly" ||
      schedule.kind === "monthly"
        ? schedule.time
        : "09:00",
    everyMinutes:
      schedule.kind === "interval" ? String(schedule.everyMinutes) : "60",
    daysOfWeek: schedule.kind === "weekly" ? schedule.daysOfWeek : [1],
    daysOfMonth: schedule.kind === "monthly" ? schedule.daysOfMonth : [1],
    startDate: task.startDate ?? localTodayDateValue(),
    endDate: task.endDate ?? "",
    prompt:
      "kind" in task.action && task.action.kind === "another-workbench.prompt"
        ? task.action.prompt
        : task.source?.prompt ?? ""
  };
};

const parseIntervalMinutes = (value: string): number => {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error("Interval minutes must be a positive whole number.");
  }
  const everyMinutes = Number(trimmedValue);
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1) {
    throw new Error("Interval minutes must be a positive whole number.");
  }
  return everyMinutes;
};

const buildScheduleFromDraft = (
  draft: ScheduleDraft
): SchedulerTaskScheduleRpc => {
  switch (draft.scheduleKind) {
    case "once":
      if (!draft.runAt) {
        throw new Error("Run at is required for one-time schedules.");
      }
      {
        const runAt = new Date(draft.runAt);
        if (Number.isNaN(runAt.getTime())) {
          throw new Error("Run at must be a valid local date and time.");
        }
        return {
          kind: "once",
          runAt: runAt.toISOString()
        };
      }
    case "interval":
      return {
        kind: "interval",
        everyMinutes: parseIntervalMinutes(draft.everyMinutes)
      };
    case "weekly":
      return {
        kind: "weekly",
        time: draft.time,
        daysOfWeek: draft.daysOfWeek.length > 0 ? draft.daysOfWeek : [1]
      };
    case "monthly":
      return {
        kind: "monthly",
        time: draft.time,
        daysOfMonth: draft.daysOfMonth.length > 0 ? draft.daysOfMonth : [1]
      };
    case "daily":
    default:
      return {
        kind: "daily",
        time: draft.time
      };
  }
};

const validateScheduleDraft = (draft: ScheduleDraft): void => {
  if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
    throw new Error("End date must be on or after start date.");
  }
  if (draft.scheduleKind === "interval") {
    parseIntervalMinutes(draft.everyMinutes);
  }
  if (
    (draft.scheduleKind === "daily" ||
      draft.scheduleKind === "weekly" ||
      draft.scheduleKind === "monthly") &&
    !/^\d{2}:\d{2}$/.test(draft.time)
  ) {
    throw new Error("Time must be set for repeating schedules.");
  }
};

const buildValidatedScheduleFromDraft = (
  draft: ScheduleDraft
): SchedulerTaskScheduleRpc => {
  validateScheduleDraft(draft);
  return buildScheduleFromDraft(draft);
};

const formatSchedulerTaskSummary = (task: SchedulerTaskDocumentRpc): string => {
  switch (task.schedule.kind) {
    case "once":
      return `Once at ${formatLocalDateTimeSummary(task.schedule.runAt)}`;
    case "interval":
      return `Every ${task.schedule.everyMinutes} min`;
    case "daily":
      return `Daily at ${task.schedule.time}`;
    case "weekly":
      return `Weekly at ${task.schedule.time}`;
    case "monthly":
      return `Monthly at ${task.schedule.time}`;
  }
};

const ScheduleWorkspaceModal = ({
  workspace,
  transport,
  onClose,
  onStatusNotice
}: ScheduleWorkspaceModalProps): ReactElement => {
  const [rootPath, setRootPath] = useState("");
  const [tasks, setTasks] = useState<SchedulerTaskDocumentRpc[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    createEmptyScheduleDraft(workspace)
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadTasks = useCallback(
    async (nextSelectedTaskId?: string): Promise<void> => {
      if (!transport) {
        return;
      }
      setIsLoading(true);
      try {
        const result = await transport.scheduler.list({
          workspaceId: workspace.workspaceId
        });
        setRootPath(result.rootPath);
        setTasks(result.tasks);
        const resolvedTask =
          result.tasks.find((task) => task.id === nextSelectedTaskId) ??
          result.tasks[0];
        if (resolvedTask) {
          setSelectedTaskId(resolvedTask.id);
          setDraft(draftFromTask(resolvedTask));
        } else {
          setSelectedTaskId("");
          setDraft(createEmptyScheduleDraft(workspace));
        }
      } catch (error) {
        onStatusNotice({
          message: `Schedule load failed: ${(error as Error).message}`,
          persistent: true,
          source: "scheduler",
          ...statusNoticeErrorDetails(error)
        });
      } finally {
        setIsLoading(false);
      }
    },
    [onStatusNotice, transport, workspace]
  );

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const selectTask = (task: SchedulerTaskDocumentRpc): void => {
    setSelectedTaskId(task.id);
    setDraft(draftFromTask(task));
  };

  const newTask = (): void => {
    setSelectedTaskId("");
    setDraft(createEmptyScheduleDraft(workspace));
  };

  const toggleWeekDay = (value: number): void => {
    setDraft((current) => ({
      ...current,
      daysOfWeek: current.daysOfWeek.includes(value)
        ? current.daysOfWeek.filter((day) => day !== value)
        : [...current.daysOfWeek, value].sort((left, right) => left - right)
    }));
  };

  const toggleMonthDay = (value: number): void => {
    setDraft((current) => ({
      ...current,
      daysOfMonth: current.daysOfMonth.includes(value)
        ? current.daysOfMonth.filter((day) => day !== value)
        : [...current.daysOfMonth, value].sort((left, right) => left - right)
    }));
  };

  const saveTask = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name || !prompt) {
      onStatusNotice({
        message: "Schedule name and prompt are required.",
        persistent: true,
        source: "scheduler"
      });
      return;
    }
    const taskId = draft.taskId;
    setIsSaving(true);
    try {
      const schedule = buildValidatedScheduleFromDraft(draft);
      const saved = await transport.scheduler.upsert({
        taskId,
        name,
        enabled: draft.enabled,
        schedule,
        startDate: draft.startDate || undefined,
        endDate: draft.endDate || undefined,
        workspaceId: workspace.workspaceId,
        prompt
      });
      await loadTasks(saved.id);
      onStatusNotice({
        message: `Schedule saved: ${saved.name}`,
        source: "scheduler"
      });
    } catch (error) {
      onStatusNotice({
        message: `Schedule save failed: ${(error as Error).message}`,
        persistent: true,
        source: "scheduler",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSaving(false);
    }
  };

  const deleteTask = async (): Promise<void> => {
    if (!transport || !selectedTaskId) {
      return;
    }
    setIsSaving(true);
    try {
      const result = await transport.scheduler.delete({
        taskId: selectedTaskId,
        workspaceId: workspace.workspaceId
      });
      await loadTasks("");
      onStatusNotice({
        message: result.deleted
          ? `Schedule deleted: ${result.taskId}`
          : `Schedule not found: ${result.taskId}`,
        source: "scheduler"
      });
    } catch (error) {
      onStatusNotice({
        message: `Schedule delete failed: ${(error as Error).message}`,
        persistent: true,
        source: "scheduler",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="awb-modal-scrim" role="presentation" onClick={onClose}>
      <section
        className="awb-modal awb-scheduler-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="awb-scheduler-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="awb-modal__header">
          <div>
            <span className="awb-main__eyebrow">Schedule</span>
            <h2 id="awb-scheduler-title">{workspace.label}</h2>
          </div>
          <button type="button" className="awb-ghost-button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="awb-scheduler">
          <aside className="awb-scheduler__list">
            <div className="awb-scheduler__bar">
              <div>
                <span>Tasks</span>
                <code title={rootPath || "~/.another-workbench/scheduler/tasks"}>
                  {rootPath || "~/.another-workbench/scheduler/tasks"}
                </code>
              </div>
              <button
                type="button"
                className="awb-secondary-button awb-secondary-button--small"
                onClick={newTask}
              >
                New
              </button>
            </div>
            <div className="awb-scheduler__items">
              {tasks.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className={task.id === selectedTaskId ? "is-active" : undefined}
                  onClick={() => selectTask(task)}
                >
                  <strong>{task.name}</strong>
                  <span>{formatSchedulerTaskSummary(task)}</span>
                  <em>{task.enabled ? "Enabled" : "Disabled"}</em>
                </button>
              ))}
              {tasks.length === 0 && (
                <p>{isLoading ? "Loading..." : "No scheduled tasks"}</p>
              )}
            </div>
          </aside>
          <section className="awb-scheduler__editor">
            <label className="awb-field">
              <span>Task name</span>
              <input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value
                  }))
                }
              />
            </label>
            <div className="awb-scheduler__grid">
              <label className="awb-field">
                <span>Frequency</span>
                <select
                  value={draft.scheduleKind}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      scheduleKind: event.target.value as ScheduleDraft["scheduleKind"]
                    }))
                  }
                >
                  <option value="once">Once</option>
                  <option value="interval">Every N minutes</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {draft.scheduleKind === "once" ? (
                <label className="awb-field">
                  <span>Run at</span>
                  <input
                    type="datetime-local"
                    value={draft.runAt}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        runAt: event.target.value
                      }))
                    }
                  />
                </label>
              ) : draft.scheduleKind === "interval" ? (
                <label className="awb-field">
                  <span>Minutes</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.everyMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        everyMinutes: event.target.value
                      }))
                    }
                  />
                </label>
              ) : (
                <label className="awb-field">
                  <span>Time</span>
                  <input
                    type="time"
                    value={draft.time}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        time: event.target.value
                      }))
                    }
                  />
                </label>
              )}
            </div>
            {draft.scheduleKind === "weekly" && (
              <div className="awb-scheduler__choice-set">
                {weekDayOptions.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    className={
                      draft.daysOfWeek.includes(option.value) ? "is-active" : undefined
                    }
                    onClick={() => toggleWeekDay(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            {draft.scheduleKind === "monthly" && (
              <div className="awb-scheduler__month-grid">
                {monthDayOptions.map((day) => (
                  <button
                    type="button"
                    key={day}
                    className={draft.daysOfMonth.includes(day) ? "is-active" : undefined}
                    onClick={() => toggleMonthDay(day)}
                  >
                    {day}
                  </button>
                ))}
              </div>
            )}
            <div className="awb-scheduler__grid">
              <label className="awb-field">
                <span>Start date</span>
                <input
                  type="date"
                  value={draft.startDate}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      startDate: event.target.value
                    }))
                  }
                />
              </label>
              <label className="awb-field">
                <span>End date</span>
                <input
                  type="date"
                  value={draft.endDate}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      endDate: event.target.value
                    }))
                  }
                />
              </label>
            </div>
            <label className="awb-field awb-field--scheduler-prompt">
              <span>Prompt</span>
              <textarea
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    prompt: event.target.value
                  }))
                }
                spellCheck={false}
              />
            </label>
            <footer className="awb-scheduler__footer">
              <label className="awb-scheduler__enabled">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      enabled: event.target.checked
                    }))
                  }
                />
                <span>Enabled</span>
              </label>
              <div>
                <button
                  type="button"
                  className="awb-ghost-button"
                  disabled={!selectedTaskId || isSaving}
                  onClick={() => void deleteTask()}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="awb-secondary-button"
                  disabled={isSaving}
                  onClick={() => void saveTask()}
                >
                  Save
                </button>
              </div>
            </footer>
          </section>
        </div>
      </section>
    </div>
  );
};

export const ChatShellApp = ({
  store,
  transport,
  title = "Another Workbench"
}: ChatShellAppProps): ReactElement => {
  const state = useRendererStoreState(store);
  const [availableEngines, setAvailableEngines] = useState<EngineDefinitionRpc[]>([]);
  const [engineSurfacesById, setEngineSurfacesById] = useState<
    Record<string, EngineSurfaceRpc | undefined>
  >({});
  const [selectedEngineId, setSelectedEngineId] = useState<string>("");
  const [statusNotice, setStatusNoticeState] = useState<ComposerStatusNotice | undefined>();
  const [sessionWindows, setSessionWindows] = useState<
    Record<string, SessionWindowCoverage | undefined>
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
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | undefined>();
  const [scheduleWorkspace, setScheduleWorkspace] =
    useState<ScheduleWorkspaceTarget | undefined>();
  const [takeoverPresets, setTakeoverPresets] = useState<
    TakeoverPresetSummaryRpc[]
  >([]);
  const [takeoverState, setTakeoverState] = useState<
    TakeoverSessionStateRpc | undefined
  >();
  const takeoverStateRequestRef = useRef(createTakeoverStateRequestState());
  const goalTakeoverDisableRef = useRef<string | undefined>(undefined);
  const [takeoverContextCacheBySessionId, setTakeoverContextCacheBySessionId] =
    useState<Record<string, Record<string, string>>>({});
  const [isTakeoverMenuOpen, setIsTakeoverMenuOpen] = useState(false);
  const [isTakeoverContextEditorOpen, setIsTakeoverContextEditorOpen] =
    useState(false);
  const [draftTakeoverContext, setDraftTakeoverContext] = useState("");
  const [isSavingTakeoverContext, setIsSavingTakeoverContext] = useState(false);

  const writeStatusNoticeLog = useCallback(
    (notice: ComposerStatusNotice): void => {
      if (notice.severity !== "error" || !transport) {
        return;
      }
      const stack =
        notice.stack ??
        new Error(`Status notice emitted: ${notice.message}`).stack;
      void transport.errorLog
        .write({
          message: notice.message,
          severity: "error",
          source: notice.source,
          stack,
          context: {
            persistent: notice.persistent ?? false,
            ...notice.context
          }
        })
        .catch(() => undefined);
    },
    [transport]
  );

  const setStatusNotice = useCallback(
    (action: SetStateAction<ComposerStatusNotice | undefined>): void => {
      if (typeof action === "function") {
        setStatusNoticeState((current) => {
          const next = action(current);
          if (next && next !== current) {
            writeStatusNoticeLog(next);
          }
          return next;
        });
        return;
      }
      if (action) {
        writeStatusNoticeLog(action);
      }
      setStatusNoticeState(action);
    },
    [writeStatusNoticeLog]
  );

  const requestTakeoverState = useCallback(
    (sessionId: string): void => {
      if (!transport) {
        return;
      }

      const run = (): void => {
        const generation = beginTakeoverStateRequest(
          takeoverStateRequestRef.current,
          sessionId
        );
        if (generation === undefined) {
          return;
        }
        void transport.takeover
          .getState(sessionId)
          .then((stateResult) => {
            if (
              canCommitTakeoverStateRequest(
                takeoverStateRequestRef.current,
                sessionId,
                generation
              )
            ) {
              setTakeoverState(resolveCurrentTakeoverState(stateResult, sessionId));
            }
          })
          .catch((error) => {
            if (
              canCommitTakeoverStateRequest(
                takeoverStateRequestRef.current,
                sessionId,
                generation
              )
            ) {
              setStatusNotice({
                message: `Takeover state load failed: ${(error as Error).message}`,
                source: "takeover",
                ...statusNoticeErrorDetails(error)
              });
            }
          })
          .finally(() => {
            if (
              finishTakeoverStateRequest(
                takeoverStateRequestRef.current,
                sessionId,
                generation
              )
            ) {
              run();
            }
          });
      };

      run();
    },
    [setStatusNotice, transport]
  );

  useEffect(() => {
    resetTakeoverStateRequests(takeoverStateRequestRef.current);
    setTakeoverState(undefined);
  }, [transport]);

  const {
    workspaceTree,
    refreshSessionBrowser,
    ensureSessionVisible,
    onAddWorkspace,
    onToggleWorkspace,
    onToggleSessionTree,
    onLoadMoreSessionChildren,
    onPreviousWorkspacePage,
    onNextWorkspacePage
  } = useWorkspaceBrowserController({
    transport,
    refreshSignal: state.refreshSignals.sessionBrowser,
    focusSessionId: openingSessionId ?? browserSelectedSessionId ?? state.activeSessionId,
    openingSessionId,
    onStatusNotice: setStatusNotice
  });

  useEffect(() => {
    const handleWindowClick = () => setWorkspaceMenu(undefined);
    const handleWindowContextMenu = (event: MouseEvent) => {
      if (shouldDismissFloatingMenuForContextMenu(event)) {
        setWorkspaceMenu(undefined);
      }
    };
    window.addEventListener("click", handleWindowClick);
    window.addEventListener("contextmenu", handleWindowContextMenu, true);
    return () => {
      window.removeEventListener("click", handleWindowClick);
      window.removeEventListener("contextmenu", handleWindowContextMenu, true);
    };
  }, []);

  const activeWorkspace = workspaceTree.find((workspace) => workspace.isActive);
  const activeSessionNode =
    findActiveSessionNode(workspaceTree) ??
    (state.activeSessionId
      ? findSessionNode(workspaceTree, state.activeSessionId)
      : undefined);
  const activeSessionId = state.activeSessionId ?? activeSessionNode?.sessionId;
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const currentTakeoverState = resolveCurrentTakeoverState(
    takeoverState,
    activeSessionId
  );
  const displayedSessionId =
    openingSessionId ?? browserSelectedSessionId ?? activeSessionId;
  const displayedSessionRevision = useRendererSessionRevision(
    store,
    displayedSessionId
  );
  const activeSessionRevision = useRendererSessionRevision(
    store,
    activeSessionId !== displayedSessionId ? activeSessionId : undefined
  );
  const domain = store.getDomainReadModel();
  const activeSessionWindow =
    displayedSessionId ? sessionWindows[displayedSessionId] : undefined;
  const loadingOlderTurns = loadingOlderSessionId === displayedSessionId;
  const displayedSessionNode = displayedSessionId
    ? findSessionNode(workspaceTree, displayedSessionId)
    : activeSessionNode;
  const displayedSession = displayedSessionId
    ? domain.getSession(displayedSessionId)
    : undefined;
  const displayedEngineId =
    displayedSession?.engineId ?? displayedSessionNode?.engineId ?? selectedEngineId;
  const activeSession = activeSessionId
    ? domain.getSession(activeSessionId)
    : undefined;
  const activeThreadGoal = activeSessionId
    ? domain.getThreadGoal(activeSessionId)
    : undefined;
  const cacheTakeoverContext = useCallback(
    (sessionId?: string, presetId?: string, context?: string): void => {
      if (!sessionId || !presetId) {
        return;
      }
      const trimmedContext = context?.trim();
      setTakeoverContextCacheBySessionId((current) => {
        const currentSessionCache = current[sessionId] ?? {};
        if (!trimmedContext) {
          if (!(presetId in currentSessionCache)) {
            return current;
          }
          const nextSessionCache = { ...currentSessionCache };
          delete nextSessionCache[presetId];
          return {
            ...current,
            [sessionId]: nextSessionCache
          };
        }
        if (currentSessionCache[presetId] === trimmedContext) {
          return current;
        }
        return {
          ...current,
          [sessionId]: {
            ...currentSessionCache,
            [presetId]: trimmedContext
          }
        };
      });
    },
    []
  );

  useEffect(() => {
    setIsTakeoverMenuOpen(false);
    setIsTakeoverContextEditorOpen(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeThreadGoal) {
      goalTakeoverDisableRef.current = undefined;
      return;
    }
    setIsTakeoverMenuOpen(false);
    setIsTakeoverContextEditorOpen(false);
    if (
      !transport ||
      !activeSessionId ||
      currentTakeoverState?.role !== "managed"
    ) {
      return;
    }
    const takeoverPresetId =
      currentTakeoverState.presetId ?? currentTakeoverState.manualPresetId ?? "";
    const disableKey = [
      activeSessionId,
      activeThreadGoal.updatedAt,
      takeoverPresetId,
      currentTakeoverState.active ? "active" : "idle"
    ].join(":");
    if (goalTakeoverDisableRef.current === disableKey) {
      return;
    }
    goalTakeoverDisableRef.current = disableKey;
    void transport.takeover
      .setManual({ sessionId: activeSessionId })
      .then((nextState) => {
        if (activeSessionIdRef.current !== activeSessionId) {
          return;
        }
        invalidateTakeoverStateRequestsForSession(
          takeoverStateRequestRef.current,
          activeSessionId
        );
        setTakeoverState(resolveCurrentTakeoverState(nextState, activeSessionId));
        void refreshSessionBrowser({ mode: "visible" });
        setStatusNotice({
          message: "Takeover disabled while a goal is active.",
          source: "takeover"
        });
      })
      .catch((error) => {
        setStatusNotice({
          message: `Takeover disable failed: ${(error as Error).message}`,
          persistent: true,
          source: "takeover",
          ...statusNoticeErrorDetails(error)
        });
      });
  }, [
    activeSessionId,
    activeThreadGoal,
    currentTakeoverState?.active,
    currentTakeoverState?.manualPresetId,
    currentTakeoverState?.presetId,
    currentTakeoverState?.role,
    refreshSessionBrowser,
    setStatusNotice,
    transport
  ]);

  useEffect(() => {
    if (!transport) {
      setTakeoverPresets([]);
      return;
    }
    let disposed = false;
    void transport.takeoverPresets
      .list()
      .then((result) => {
        if (!disposed) {
          setTakeoverPresets(result.presets);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Takeover presets load failed: ${(error as Error).message}`,
            persistent: true,
            source: "takeover",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [setStatusNotice, transport]);

  useEffect(() => {
    if (!transport || !activeSessionId) {
      resetTakeoverStateRequests(takeoverStateRequestRef.current);
      setTakeoverState(undefined);
      return;
    }
    setTakeoverState((current) =>
      resolveCurrentTakeoverState(current, activeSessionId)
    );
    requestTakeoverState(activeSessionId);
  }, [activeSessionId, requestTakeoverState, state.refreshSignals.takeover, transport]);

  useEffect(() => {
    const presetId =
      currentTakeoverState?.presetId ?? currentTakeoverState?.manualPresetId;
    if (typeof currentTakeoverState?.context === "string") {
      cacheTakeoverContext(activeSessionId, presetId, currentTakeoverState.context);
    }
  }, [
    activeSessionId,
    cacheTakeoverContext,
    currentTakeoverState?.context,
    currentTakeoverState?.manualPresetId,
    currentTakeoverState?.presetId
  ]);

  useRendererDiagnostics({
    transport,
    activeSessionId,
    activeWorkspaceId: activeWorkspace?.workspaceId,
    eventCursor: state.eventStream.lastCursor
  });

  const displayedConversationId =
    displayedSession?.conversationId;
  const displayedConversationRevision = useRendererConversationRevision(
    store,
    displayedConversationId
  );
  const highlightedSessionId = displayedSessionId;
  const isOpeningSelectedSession =
    Boolean(openingSessionId) && openingSessionId === displayedSessionId;
  const browsedSessionId =
    displayedSessionId && !isOpeningSelectedSession ? displayedSessionId : undefined;
  const activeConversation =
    (displayedConversationId
      ? domain.getConversation(displayedConversationId)
      : undefined) ??
    (displayedSession?.conversationId
      ? domain.getConversation(displayedSession.conversationId)
      : undefined) ??
    (state.activeConversationId
      ? domain.getConversation(state.activeConversationId)
      : undefined);
  const turns = useMemo(
    () => displayedSessionId ? domain.listTurns({ sessionId: displayedSessionId }) : emptyTurns,
    [domain, displayedSessionId, displayedSessionRevision]
  );
  const participants = useMemo(
    () => activeConversation
      ? domain.listParticipants({ conversationId: activeConversation.conversationId })
      : emptyParticipants,
    [activeConversation?.conversationId, displayedConversationRevision, domain]
  );
  const participantDirectory = useMemo(
    () => buildParticipantDirectory(participants),
    [participants]
  );
  const transcriptRows = useMemo(
    () => buildTurnTranscriptRows(domain, turns, participantDirectory),
    [domain, turns, participantDirectory]
  );
  const transcriptContentVersion = useMemo(
    () => buildTranscriptContentVersion(transcriptRows),
    [transcriptRows]
  );

  const viewport = useTranscriptViewportController({
    displayedSessionId,
    isOpeningSelectedSession,
    windowStartTurnId: activeSessionWindow?.windowStartTurnId,
    windowEndTurnId: activeSessionWindow?.windowEndTurnId,
    renderedTranscriptRowCount: transcriptRows.length,
    transcriptContentVersion
  });

  const resetSessionSwitchState = (): void => {
    setLoadingOlderSessionId(undefined);
    setProcessVisibilityByTurnId({});
  };

  const {
    reloadSessionWindow,
    refreshDisplayedSessionWindow,
    onLoadOlder,
    onCreateSession,
    onOpenSession
  } = useSessionOpenController({
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
    refreshSessionBrowser,
    ensureSessionVisible
  });
  const backlogAutoRefreshRef = useRef<{
    displayedSessionId?: string;
    refreshDisplayedSessionWindow: typeof refreshDisplayedSessionWindow;
    isOpeningSelectedSession: boolean;
    lastRefreshStartedAtMs?: number;
    refreshInFlight: boolean;
    pendingPressure?: EventBacklogPressure;
  }>({
    displayedSessionId,
    refreshDisplayedSessionWindow,
    isOpeningSelectedSession,
    refreshInFlight: false
  });
  if (backlogAutoRefreshRef.current.displayedSessionId !== displayedSessionId) {
    backlogAutoRefreshRef.current.pendingPressure = undefined;
  }
  backlogAutoRefreshRef.current.displayedSessionId = displayedSessionId;
  backlogAutoRefreshRef.current.refreshDisplayedSessionWindow =
    refreshDisplayedSessionWindow;
  backlogAutoRefreshRef.current.isOpeningSelectedSession = isOpeningSelectedSession;
  if (isOpeningSelectedSession) {
    backlogAutoRefreshRef.current.pendingPressure = undefined;
  }

  const attemptBacklogAutoRefresh = useCallback(
    (incomingPressure?: EventBacklogPressure): void => {
      const current = backlogAutoRefreshRef.current;
      if (current.isOpeningSelectedSession) {
        current.pendingPressure = undefined;
        return;
      }
      const nowMs =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      const result = resolveAutoRefreshBacklogAttempt({
        incomingPressure,
        pendingPressure: current.pendingPressure,
        displayedSessionId: current.displayedSessionId,
        visibilityState:
          typeof document === "undefined" ? "visible" : document.visibilityState,
        nowMs,
        lastRefreshStartedAtMs: current.lastRefreshStartedAtMs,
        refreshInFlight: current.refreshInFlight,
        cooldownMs: autoRefreshBacklogCooldownMs,
        streamThreshold: autoRefreshBacklogStreamThreshold
      });
      current.pendingPressure = result.pendingPressure;
      const decision = result.decision;
      if (!decision) {
        return;
      }
      current.lastRefreshStartedAtMs = nowMs;
      current.refreshInFlight = true;
      void current
        .refreshDisplayedSessionWindow(decision.sessionId, {
          forceProviderHydration: true,
          preserveViewport: true
        })
        .catch(() => undefined)
        .finally(() => {
          backlogAutoRefreshRef.current.refreshInFlight = false;
        });
    },
    []
  );

  const onBacklogPressure = useCallback(
    (pressure: EventBacklogPressure): void => {
      attemptBacklogAutoRefresh(pressure);
    },
    [attemptBacklogAutoRefresh]
  );

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        attemptBacklogAutoRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [attemptBacklogAutoRefresh]);

  const {
    chatTree,
    onJumpChatTree
  } = useChatTreeController({
    transport,
    browsedSessionId,
    displayedSessionId,
    displayedSessionIdRef: viewport.displayedSessionIdRef,
    isOpeningSelectedSession,
    refreshSignal: state.refreshSignals.chatTree,
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
  const activeSessionApprovals = useMemo(
    () =>
      activeSessionId
        ? domain.listApprovalRequests().filter(
            (approval): approval is ApprovalRequest =>
              approval.sessionId === activeSessionId && approval.status === "pending"
          )
        : [],
    [activeSessionId, activeSessionRevision, displayedSessionRevision, domain]
  );
  const activeSessionInteractions = useMemo(
    () =>
      activeSessionId
        ? domain.listRuntimeInteractions({ sessionId: activeSessionId }).filter(
            (interaction): interaction is RuntimeInteraction =>
              interaction.sessionId === activeSessionId && interaction.status === "pending"
          )
        : [],
    [activeSessionId, activeSessionRevision, displayedSessionRevision, domain]
  );

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
      onOpenSession,
      onResumeSession: reloadSessionWindow,
      onStatusNotice: setStatusNotice
    });

  const fallbackEngines = useMemo(
    () => buildWorkspaceEngineFallbacks(workspaceTree),
    [workspaceTree]
  );
  const engines = useMemo(
    () => uniqueByEngineId([...availableEngines, ...fallbackEngines]),
    [availableEngines, fallbackEngines]
  );

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
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [transport]);

  useEffect(() => {
    if (settingsHydrated && !selectedEngineId && engines.length > 0) {
      setSelectedEngineId(engines[0]!.engineId);
    }
  }, [engines, selectedEngineId, settingsHydrated]);

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
            source: "settings",
            ...statusNoticeErrorDetails(error)
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
    void transport.engine
      .select({ engineId: selectedEngineId })
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
            source: "engine-select",
            ...statusNoticeErrorDetails(error)
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
            source: "settings",
            ...statusNoticeErrorDetails(error)
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
      store,
      onBacklogPressure
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
            source: "subscription",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
      if (unsubscribe) {
        void unsubscribe();
      }
    };
  }, [transport, store, onBacklogPressure]);

  const onRespondApproval = useCallback(async (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
    decision?: string | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.approval.respond(input);
  }, [transport]);

  const onRespondInteraction = useCallback(async (input: {
    sessionId: string;
    requestId: string;
    action: "accept" | "decline" | "cancel" | "submit" | "defer";
    response?: Record<string, unknown>;
    content?: unknown;
    answers?: Record<string, string[]>;
  }): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.interaction.respond(input);
  }, [transport]);

  const onToggleProcess = useCallback((turnId: string, defaultExpanded: boolean): void => {
    setProcessVisibilityByTurnId((current) =>
      toggleProcessVisibility(current, turnId, defaultExpanded)
    );
  }, []);

  const onActivateResourceLink = useCallback((reference: ExtractedFileReference): void => {
    setDetailTab("files");
    fileBrowser.selectFile(reference);
  }, [fileBrowser.selectFile]);

  const onPreviewImage = useCallback((image: ImageLightboxState): void => {
    setLightboxImage(image);
  }, []);

  const onOpenWorkspaceMenu = useCallback(
    (
      event: ReactMouseEvent,
      workspace: WorkspaceBrowserViewNode
    ): void => {
      event.preventDefault();
      event.stopPropagation();
      setWorkspaceMenu({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        rootPath: workspace.rootPath,
        x: event.clientX,
        y: event.clientY,
        actions: ["schedule", "open_directory", "remove_workspace"]
      });
    },
    []
  );

  const onRunWorkspaceMenuAction = useCallback(
    async (
      workspaceMenuState: WorkspaceMenuState,
      action: WorkspaceMenuAction
    ): Promise<void> => {
      setWorkspaceMenu(undefined);
      if (action === "schedule") {
        setScheduleWorkspace({
          workspaceId: workspaceMenuState.workspaceId,
          label: workspaceMenuState.label,
          rootPath: workspaceMenuState.rootPath
        });
        return;
      }
      if (action === "remove_workspace") {
        if (!transport) {
          return;
        }
        const confirmed = window.confirm(
          `Remove workspace "${workspaceMenuState.label}" from Another Workbench? Files on disk will not be deleted.`
        );
        if (!confirmed) {
          return;
        }
        try {
          const result = await transport.workspace.remove({
            workspaceId: workspaceMenuState.workspaceId
          });
          await refreshSessionBrowser({
            mode: "all"
          });
          setStatusNotice({
            message: result.removed
              ? `Removed workspace ${workspaceMenuState.label}`
              : `Workspace ${workspaceMenuState.label} was already removed.`,
            source: "workspace-action"
          });
        } catch (error) {
          setStatusNotice({
            message: `Remove workspace failed: ${(error as Error).message}`,
            persistent: true,
            source: "workspace-action",
            ...statusNoticeErrorDetails(error)
          });
        }
        return;
      }
      if (action !== "open_directory") {
        return;
      }
      await openWorkspaceDirectory({
        transport,
        workspace: {
          label: workspaceMenuState.label,
          rootPath: workspaceMenuState.rootPath
        },
        onStatusNotice: setStatusNotice
      });
    },
    [refreshSessionBrowser, transport, setStatusNotice]
  );

  const onSelectTakeoverPreset = useCallback(
    async (presetId?: string): Promise<void> => {
      if (!transport || !activeSessionId) {
        return;
      }
      if (presetId && activeThreadGoal) {
        setIsTakeoverMenuOpen(false);
        setStatusNotice({
          message: "Takeover is unavailable while a goal is active.",
          source: "takeover"
        });
        return;
      }
      try {
        const currentPresetId =
          currentTakeoverState?.presetId ?? currentTakeoverState?.manualPresetId;
        cacheTakeoverContext(
          activeSessionId,
          currentPresetId,
          currentTakeoverState?.context
        );
        const cachedContext = presetId
          ? takeoverContextCacheBySessionId[activeSessionId]?.[presetId]
          : undefined;
        const nextState = await transport.takeover.setManual({
          sessionId: activeSessionId,
          presetId,
          context: cachedContext
        });
        if (activeSessionIdRef.current !== activeSessionId) {
          return;
        }
        invalidateTakeoverStateRequestsForSession(
          takeoverStateRequestRef.current,
          activeSessionId
        );
        setTakeoverState(resolveCurrentTakeoverState(nextState, activeSessionId));
        setIsTakeoverMenuOpen(false);
        await refreshSessionBrowser({ mode: "visible" });
        setStatusNotice({
          message: presetId
            ? `Takeover enabled: ${presetId}`
            : "Takeover disabled.",
          source: "takeover"
        });
      } catch (error) {
        setStatusNotice({
          message: `Takeover update failed: ${(error as Error).message}`,
          persistent: true,
          source: "takeover",
          ...statusNoticeErrorDetails(error)
        });
      }
    },
    [
      activeSessionId,
      activeThreadGoal,
      cacheTakeoverContext,
      currentTakeoverState?.context,
      currentTakeoverState?.manualPresetId,
      currentTakeoverState?.presetId,
      refreshSessionBrowser,
      setStatusNotice,
      takeoverContextCacheBySessionId,
      transport
    ]
  );

  const onOpenTakeoverContextEditor = useCallback((): void => {
    setDraftTakeoverContext(currentTakeoverState?.context ?? "");
    setIsTakeoverContextEditorOpen(true);
  }, [currentTakeoverState?.context]);

  const onCloseTakeoverContextEditor = useCallback((): void => {
    if (isSavingTakeoverContext) {
      return;
    }
    setIsTakeoverContextEditorOpen(false);
  }, [isSavingTakeoverContext]);

  const onSaveTakeoverContext = useCallback(async (): Promise<void> => {
    const presetId =
      currentTakeoverState?.presetId ?? currentTakeoverState?.manualPresetId;
    if (!transport || !activeSessionId || !presetId) {
      setIsTakeoverContextEditorOpen(false);
      return;
    }
    if (activeThreadGoal) {
      setIsTakeoverContextEditorOpen(false);
      setStatusNotice({
        message: "Takeover is unavailable while a goal is active.",
        source: "takeover"
      });
      return;
    }
    const willRestartReview = currentTakeoverState?.active === true;
    if (
      willRestartReview &&
      typeof window !== "undefined" &&
      !window.confirm(
        "Takeover is responding now. Saving this context will interrupt the current review and start a new one."
      )
    ) {
      return;
    }
    setIsSavingTakeoverContext(true);
    try {
      const nextState = await transport.takeover.setManual({
        sessionId: activeSessionId,
        presetId,
        context: draftTakeoverContext.trim()
          ? draftTakeoverContext.trim()
          : undefined
      });
      if (activeSessionIdRef.current !== activeSessionId) {
        return;
      }
      invalidateTakeoverStateRequestsForSession(
        takeoverStateRequestRef.current,
        activeSessionId
      );
      cacheTakeoverContext(activeSessionId, presetId, draftTakeoverContext);
      setTakeoverState(resolveCurrentTakeoverState(nextState, activeSessionId));
      setIsTakeoverContextEditorOpen(false);
      await refreshSessionBrowser({ mode: "visible" });
      setStatusNotice({
        message: willRestartReview
          ? "Takeover review restarted with updated context."
          : "Takeover context updated.",
        source: "takeover"
      });
    } catch (error) {
      setStatusNotice({
        message: `Takeover context update failed: ${(error as Error).message}`,
        persistent: true,
        source: "takeover",
        ...statusNoticeErrorDetails(error)
      });
    } finally {
      setIsSavingTakeoverContext(false);
    }
  }, [
    activeSessionId,
    activeThreadGoal,
    cacheTakeoverContext,
    currentTakeoverState?.active,
    currentTakeoverState?.manualPresetId,
    currentTakeoverState?.presetId,
    draftTakeoverContext,
    refreshSessionBrowser,
    setStatusNotice,
    transport
  ]);

  const onToggleTakeoverMenu = useCallback((): void => {
    const shouldOpen = !isTakeoverMenuOpen;
    setIsTakeoverMenuOpen(shouldOpen);
    if (!shouldOpen || !transport) {
      return;
    }
    void transport.takeoverPresets
      .list()
      .then((result) => setTakeoverPresets(result.presets))
      .catch((error) =>
        setStatusNotice({
          message: `Takeover presets load failed: ${(error as Error).message}`,
          persistent: true,
          source: "takeover",
          ...statusNoticeErrorDetails(error)
        })
      );
  }, [isTakeoverMenuOpen, setStatusNotice, transport]);

  const renderSessionNode = (
    session: SessionBrowserViewNode,
    depth = 0
  ): ReactElement => {
    const statusDot = resolveStatusDotLabel(session.statusDot);
    const lastCompletedTurnAt = session.lastCompletedTurnAt;
    const completedAge = formatRelativeCompletedTurnAge(lastCompletedTurnAt);
    const takeoverBadge =
      session.takeoverStatus === "managed"
        ? "Managed"
        : session.takeoverStatus === "agent"
          ? "Takeover"
          : undefined;
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
            {statusDot ? <span className={`awb-tree__dot is-${statusDot}`} /> : <span className="awb-tree__dot-placeholder" />}
            {session.childCount > 0 ? (
              <button
                type="button"
                className="awb-tree__disclosure"
                aria-label={
                  session.isExpanded
                    ? `Collapse ${session.title}`
                    : `Expand ${session.title}`
                }
                aria-expanded={session.isExpanded}
                onClick={(event) => {
                  event.stopPropagation();
                  void onToggleSessionTree(session.sessionId, session.workspaceId);
                }}
              >
                {session.isExpanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="awb-tree__indent" />
            )}
            <div className="awb-tree__labels">
              <strong>
                {takeoverBadge ? (
                  <span
                    className={`awb-tree__takeover-badge is-${session.takeoverStatus}`}
                    title={
                      session.takeoverStatus === "managed"
                        ? "This session is currently managed by takeover."
                        : "This session is a takeover agent."
                    }
                  >
                    [{takeoverBadge}]
                  </span>
                ) : null}
                {session.title}
              </strong>
              <span className="awb-tree__session-meta">
                <span>{session.engineId}</span>
                {completedAge && lastCompletedTurnAt ? (
                  <time dateTime={lastCompletedTurnAt} title={formatTimestamp(lastCompletedTurnAt)}>
                    {completedAge}
                  </time>
                ) : null}
              </span>
            </div>
          </div>
        </div>
        {session.isExpanded && (
          <ul className="awb-tree__branch">
            {session.children.map((child) =>
              renderSessionNode(child, depth + 1)
            )}
            {session.isLoadingChildren ? (
              <li className="awb-list__empty">Loading…</li>
            ) : null}
            {session.childrenHasMore && session.childrenNextCursor ? (
              <li className="awb-tree__item">
                <button
                  type="button"
                  className="awb-ghost-button"
                  onClick={() =>
                    void onLoadMoreSessionChildren(
                      session.sessionId,
                      session.workspaceId
                    )
                  }
                >
                  Load more
                </button>
              </li>
            ) : null}
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

  const workspaceMenuMarkup = workspaceMenu ? (
    <div
      className="awb-session-menu awb-workspace-menu"
      style={resolveWorkspaceMenuViewportStyle(workspaceMenu)}
      onClick={(event) => event.stopPropagation()}
    >
      {workspaceMenu.actions.map((action) => (
        <button
          key={action}
          type="button"
          onClick={() => void onRunWorkspaceMenuAction(workspaceMenu, action)}
        >
          {workspaceMenuActionLabel(action)}
        </button>
      ))}
    </div>
  ) : null;

  const takeoverContextEditorMarkup = isTakeoverContextEditorOpen ? (
    <div
      className="awb-modal-scrim"
      role="presentation"
      onClick={onCloseTakeoverContextEditor}
    >
      <section
        className="awb-modal awb-takeover-context-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="awb-takeover-context-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="awb-modal__header">
          <div>
            <span className="awb-main__eyebrow">Takeover</span>
            <h2 id="awb-takeover-context-title">Context</h2>
          </div>
          <button
            type="button"
            className="awb-ghost-button"
            onClick={onCloseTakeoverContextEditor}
            disabled={isSavingTakeoverContext}
          >
            Close
          </button>
        </header>
        <div className="awb-modal__body awb-takeover-context">
          {currentTakeoverState?.active ? (
            <p className="awb-takeover-context__notice">
              Takeover is responding. Saving context will interrupt this review
              and start a new one.
            </p>
          ) : null}
          <label className="awb-field awb-field--takeover-context">
            <span>Task context</span>
            <textarea
              value={draftTakeoverContext}
              onChange={(event) => setDraftTakeoverContext(event.target.value)}
              placeholder="Goals, focus files, risks, acceptance notes..."
              spellCheck={false}
            />
          </label>
        </div>
        <footer className="awb-modal__footer">
          <button
            type="button"
            className="awb-ghost-button"
            onClick={onCloseTakeoverContextEditor}
            disabled={isSavingTakeoverContext}
          >
            Cancel
          </button>
          <button
            type="button"
            className="awb-secondary-button"
            onClick={() => void onSaveTakeoverContext()}
            disabled={isSavingTakeoverContext}
          >
            {currentTakeoverState?.active ? "Restart review" : "Save context"}
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
                    onContextMenu={(event) => onOpenWorkspaceMenu(event, workspace)}
                  >
                    <div className="awb-workspace__main">
                      <button
                        type="button"
                        className="awb-workspace__disclosure"
                        aria-label={
                          workspace.isExpanded
                            ? `Collapse ${workspace.label}`
                            : `Expand ${workspace.label}`
                        }
                        aria-expanded={workspace.isExpanded}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onToggleWorkspace(workspace.workspaceId);
                        }}
                      >
                        {workspace.isExpanded ? "▾" : "▸"}
                      </button>
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
                    <>
                      <ul className="awb-tree__branch awb-tree__branch--workspace">
                        {workspace.sessions.map((session) => renderSessionNode(session))}
                        {workspace.isLoadingRoots ? (
                          <li className="awb-list__empty">Loading…</li>
                        ) : null}
                      </ul>
                      {(() => {
                        const totalPages = Math.max(
                          1,
                          Math.ceil(workspace.rootTotalCount / workspaceSessionPageSize)
                        );
                        if (totalPages <= 1) {
                          return null;
                        }
                        return (
                          <div className="awb-workspace__pagination">
                            <button
                              type="button"
                              disabled={workspace.rootPageIndex === 0 || workspace.isLoadingRoots}
                              onClick={() => void onPreviousWorkspacePage(workspace.workspaceId)}
                              aria-label={`Previous sessions page for ${workspace.label}`}
                            >
                              ‹
                            </button>
                            <span>
                              {workspace.rootPageIndex + 1}/{totalPages}
                            </span>
                            <button
                              type="button"
                              disabled={!workspace.rootHasMore || workspace.isLoadingRoots}
                              onClick={() => void onNextWorkspacePage(workspace.workspaceId)}
                              aria-label={`Next sessions page for ${workspace.label}`}
                            >
                              ›
                            </button>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </section>
              ))}
            </div>
          </section>

          <footer className="awb-sidebar__footer">
            <SettingsLauncher
              engines={engines}
              surfacesByEngineId={engineSurfacesById}
              currentEngineId={selectedEngineId}
              transport={transport}
              onEngineSaved={setSelectedEngineId}
              onTakeoverPresetsChanged={setTakeoverPresets}
              onStatusNotice={setStatusNotice}
            />
          </footer>
        </aside>

        <main className="awb-shell__main">
          <header className="awb-main__header">
            <div>
              <h2>{truncateSessionHeading(displayedSessionNode?.title)}</h2>
            </div>
          </header>

          <div className="awb-main__body">
            <TranscriptPane
              transcriptRef={viewport.transcriptRef}
              transcriptContentRef={viewport.transcriptContentRef}
              renderedTranscriptRows={renderedTranscriptRows}
              participantDirectory={participantDirectory}
              transport={transport}
              engineId={displayedEngineId}
              engineSurface={displayedEngineId ? engineSurfacesById[displayedEngineId] : undefined}
              engineExtensionRefreshSignal={state.refreshSignals.engineExtensions}
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
              onRespondInteraction={transport ? onRespondInteraction : undefined}
            />
          </div>

          <ComposerContainer
            transport={transport}
            activeSession={activeSession}
            activeSessionId={activeSessionId}
            threadGoal={activeThreadGoal}
            displayedSessionId={displayedSessionId}
            selectedEngineId={selectedEngineId}
            activeWorkspaceId={activeWorkspace?.workspaceId}
            activeWorkspaceRootPath={activeWorkspace?.rootPath}
            turns={turns}
            approvals={activeSessionApprovals}
            interactions={activeSessionInteractions}
            takeoverPresets={takeoverPresets}
            takeoverState={currentTakeoverState}
            isTakeoverMenuOpen={isTakeoverMenuOpen}
            isOpeningSelectedSession={isOpeningSelectedSession}
            statusNotice={statusNotice}
            onStatusNotice={setStatusNotice}
            onPreviewImage={onPreviewImage}
            onCreateSession={onCreateSession}
            onOpenSession={onOpenSession}
            onRequestTranscriptBottom={viewport.scrollToBottom}
            onToggleTakeoverMenu={onToggleTakeoverMenu}
            onSelectTakeoverPreset={onSelectTakeoverPreset}
            onOpenTakeoverContextEditor={onOpenTakeoverContextEditor}
            onRespondApproval={transport ? onRespondApproval : undefined}
            onRespondInteraction={transport ? onRespondInteraction : undefined}
          />
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
      {workspaceMenuMarkup &&
        (typeof document === "undefined"
          ? workspaceMenuMarkup
          : createPortal(workspaceMenuMarkup, document.body))}
      {takeoverContextEditorMarkup &&
        (typeof document === "undefined"
          ? takeoverContextEditorMarkup
          : createPortal(takeoverContextEditorMarkup, document.body))}
      {scheduleWorkspace &&
        (typeof document === "undefined" ? (
          <ScheduleWorkspaceModal
            workspace={scheduleWorkspace}
            transport={transport}
            onClose={() => setScheduleWorkspace(undefined)}
            onStatusNotice={setStatusNotice}
          />
        ) : (
          createPortal(
            <ScheduleWorkspaceModal
              workspace={scheduleWorkspace}
              transport={transport}
              onClose={() => setScheduleWorkspace(undefined)}
              onStatusNotice={setStatusNotice}
            />,
            document.body
          )
        ))}
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
};
