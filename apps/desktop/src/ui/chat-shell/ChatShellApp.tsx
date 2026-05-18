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
  Turn,
  SessionWindowRpc,
  TakeoverSessionStateRpc,
  TakeoverPresetSummaryRpc,
  WorkspaceBrowserNodeRpc
} from "@another-workbench/shared";
import "xterm/css/xterm.css";
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
import { buildParticipantDirectory } from "./participant-directory.js";
import {
  statusNoticeErrorDetails,
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
import {
  openWorkspaceDirectory,
  workspaceDirectoryActionLabel
} from "./workspace-actions.js";
import { useChatTreeController } from "./use-chat-tree-controller.js";
import { useRendererDiagnostics } from "./use-renderer-diagnostics.js";
import { buildEngineInspectorViewModel } from "./engine-summary.js";
import { ComposerContainer } from "./composer/ComposerContainer.js";
import "./chat-shell.css";

type SettingsLauncherProps = {
  engines: EngineDefinitionRpc[];
  surfacesByEngineId: Readonly<Record<string, EngineSurfaceRpc | undefined>>;
  currentEngineId: string;
  transport?: DesktopTransport;
  onEngineSaved: (engineId: string) => void;
  onStatusNotice: (notice: ComposerStatusNotice) => void;
};

type SettingsTab = "general" | "takeover";

const takeoverPresetNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
  onToggleProcess: (turnId: string, defaultExpanded: boolean) => void;
  onActivateResourceLink: (reference: ExtractedFileReference) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
  }) => Promise<void>;
};

type DetailTab = "graph" | "files";
type TranscriptRow = ReturnType<typeof buildTurnTranscriptRows>[number];
type RenderedTurnGroup = {
  visibleRow: TranscriptRow;
  hiddenRows: TranscriptRow[];
};
type WorkspaceMenuAction = "open_directory";
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
  workspaces: WorkspaceBrowserNodeRpc[]
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
                  turnId: visibleRow.turn.turnId
                })
              : null}
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
  engines,
  surfacesByEngineId,
  currentEngineId,
  transport,
  onEngineSaved,
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
    [onStatusNotice, readTakeoverPreset, selectedTakeoverPresetId, transport]
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

  const onNewTakeoverPreset = (): void => {
    const presetId = "custom-preset";
    setSelectedTakeoverPresetId("");
    setDraftTakeoverPresetId(presetId);
    setDraftTakeoverPrompt(`# ${presetId}

Use this takeover preset to describe the role, inspection scope, and verdict standard.
`);
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
                        onClick={onNewTakeoverPreset}
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
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | undefined>();
  const [workspaceSessionPages, setWorkspaceSessionPages] = useState<
    Record<string, number>
  >({});
  const [takeoverPresets, setTakeoverPresets] = useState<
    TakeoverPresetSummaryRpc[]
  >([]);
  const [takeoverState, setTakeoverState] = useState<
    TakeoverSessionStateRpc | undefined
  >();
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

  const {
    workspaceTree,
    refreshSessionBrowser,
    onAddWorkspace,
    onToggleWorkspace,
    onToggleSessionTree
  } = useWorkspaceBrowserController({
    transport,
    refreshSignal: state.refreshSignals.sessionBrowser,
    openingSessionId,
    onStatusNotice: setStatusNotice
  });

  useEffect(() => {
    const handleWindowClick = () => setWorkspaceMenu(undefined);
    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, []);

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
    displayedSession?.engineId ?? displayedSessionNode?.engineId ?? selectedEngineId;
  const activeSession = activeSessionId
    ? state.entities.sessions[activeSessionId]
    : undefined;

  useEffect(() => {
    setIsTakeoverMenuOpen(false);
    setIsTakeoverContextEditorOpen(false);
  }, [activeSessionId]);

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
      setTakeoverState(undefined);
      return;
    }
    let disposed = false;
    void transport.takeover
      .getState(activeSessionId)
      .then((stateResult) => {
        if (!disposed) {
          setTakeoverState(stateResult);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatusNotice({
            message: `Takeover state load failed: ${(error as Error).message}`,
            source: "takeover",
            ...statusNoticeErrorDetails(error)
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeSessionId, setStatusNotice, state.refreshSignals.takeover, transport]);

  useRendererDiagnostics({
    transport,
    activeSessionId,
    activeWorkspaceId: activeWorkspace?.workspaceId,
    eventCursor: state.eventStream.lastCursor
  });

  useEffect(() => {
    setWorkspaceSessionPages((current) => {
      const workspaceIds = new Set(workspaceTree.map((workspace) => workspace.workspaceId));
      let changed = false;
      const next: Record<string, number> = {};
      for (const workspace of workspaceTree) {
        const totalPages = getWorkspaceSessionPage(
          workspace.sessions,
          current[workspace.workspaceId] ?? 0
        ).totalPages;
        const currentPageIndex = current[workspace.workspaceId] ?? 0;
        const clampedPageIndex = Math.min(currentPageIndex, totalPages - 1);
        if (clampedPageIndex > 0) {
          next[workspace.workspaceId] = clampedPageIndex;
        }
        if (currentPageIndex !== clampedPageIndex) {
          changed = true;
        }
      }
      for (const workspaceId of Object.keys(current)) {
        if (!workspaceIds.has(workspaceId)) {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspaceTree]);
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
  const turnIds = displayedSessionId
    ? state.indexes.turnIdsBySession[displayedSessionId]
    : undefined;
  const turns = useMemo(
    () =>
      turnIds
        ? turnIds
            .map((turnId) => state.entities.turns[turnId])
            .filter((turn): turn is Turn => Boolean(turn))
        : emptyTurns,
    [state.entities.turns, turnIds]
  );
  const participantIds = activeConversation
    ? state.indexes.participantIdsByConversation[activeConversation.conversationId]
    : undefined;
  const participants = useMemo(
    () =>
      participantIds
        ? participantIds
            .map((participantId) => state.entities.participants[participantId])
            .filter((participant): participant is AgentParticipant => Boolean(participant))
        : emptyParticipants,
    [participantIds, state.entities.participants]
  );
  const participantDirectory = useMemo(
    () => buildParticipantDirectory(participants),
    [participants]
  );
  const transcriptRows = useMemo(
    () => buildTurnTranscriptRows(state, turns, participantDirectory),
    [state, turns, participantDirectory]
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
        ? Object.values(state.entities.approvalRequests).filter(
            (approval): approval is ApprovalRequest =>
              approval.sessionId === activeSessionId && approval.status === "pending"
          )
        : [],
    [activeSessionId, state.entities.approvalRequests]
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
  }, [transport, store]);

  const onRespondApproval = useCallback(async (input: {
    sessionId: string;
    requestId: string;
    action: "approve" | "deny" | "defer";
  }): Promise<void> => {
    if (!transport) {
      return;
    }
    await transport.approval.respond(input);
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
      workspace: WorkspaceBrowserNodeRpc
    ): void => {
      event.preventDefault();
      event.stopPropagation();
      setWorkspaceMenu({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        rootPath: workspace.rootPath,
        x: event.clientX,
        y: event.clientY,
        actions: ["open_directory"]
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
    [transport, setStatusNotice]
  );

  const onSetWorkspaceSessionPage = useCallback(
    (workspaceId: string, pageIndex: number): void => {
      setWorkspaceSessionPages((current) => ({
        ...current,
        [workspaceId]: Math.max(0, pageIndex)
      }));
    },
    []
  );

  const onSelectTakeoverPreset = useCallback(
    async (presetId?: string): Promise<void> => {
      if (!transport || !activeSessionId) {
        return;
      }
      try {
        const nextState = await transport.takeover.setManual({
          sessionId: activeSessionId,
          presetId,
          context: presetId ? takeoverState?.context : undefined
        });
        setTakeoverState(nextState);
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
    [activeSessionId, refreshSessionBrowser, setStatusNotice, takeoverState?.context, transport]
  );

  const onOpenTakeoverContextEditor = useCallback((): void => {
    setDraftTakeoverContext(takeoverState?.context ?? "");
    setIsTakeoverContextEditorOpen(true);
  }, [takeoverState?.context]);

  const onCloseTakeoverContextEditor = useCallback((): void => {
    if (isSavingTakeoverContext) {
      return;
    }
    setIsTakeoverContextEditorOpen(false);
  }, [isSavingTakeoverContext]);

  const onSaveTakeoverContext = useCallback(async (): Promise<void> => {
    const presetId = takeoverState?.presetId ?? takeoverState?.manualPresetId;
    if (!transport || !activeSessionId || !presetId) {
      setIsTakeoverContextEditorOpen(false);
      return;
    }
    const willRestartReview = takeoverState?.active === true;
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
      setTakeoverState(nextState);
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
    draftTakeoverContext,
    refreshSessionBrowser,
    setStatusNotice,
    takeoverState?.active,
    takeoverState?.manualPresetId,
    takeoverState?.presetId,
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
    session: WorkspaceBrowserNodeRpc["sessions"][number],
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
            {session.children.length > 0 ? (
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
                  void onToggleSessionTree(session.sessionId);
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
          {action === "open_directory" ? workspaceDirectoryActionLabel : action}
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
          {takeoverState?.active ? (
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
            {takeoverState?.active ? "Restart review" : "Save context"}
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
                        {getWorkspaceSessionPage(
                          workspace.sessions,
                          workspaceSessionPages[workspace.workspaceId] ?? 0
                        ).sessions.map((session) => renderSessionNode(session))}
                      </ul>
                      {(() => {
                        const page = getWorkspaceSessionPage(
                          workspace.sessions,
                          workspaceSessionPages[workspace.workspaceId] ?? 0
                        );
                        if (page.totalPages <= 1) {
                          return null;
                        }
                        return (
                          <div className="awb-workspace__pagination">
                            <button
                              type="button"
                              disabled={page.pageIndex === 0}
                              onClick={() =>
                                onSetWorkspaceSessionPage(
                                  workspace.workspaceId,
                                  page.pageIndex - 1
                                )
                              }
                              aria-label={`Previous sessions page for ${workspace.label}`}
                            >
                              ‹
                            </button>
                            <span>
                              {page.pageIndex + 1}/{page.totalPages}
                            </span>
                            <button
                              type="button"
                              disabled={page.pageIndex >= page.totalPages - 1}
                              onClick={() =>
                                onSetWorkspaceSessionPage(
                                  workspace.workspaceId,
                                  page.pageIndex + 1
                                )
                              }
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

          <ComposerContainer
            transport={transport}
            activeSession={activeSession}
            activeSessionId={activeSessionId}
            displayedSessionId={displayedSessionId}
            selectedEngineId={selectedEngineId}
            activeWorkspaceId={activeWorkspace?.workspaceId}
            activeWorkspaceRootPath={activeWorkspace?.rootPath}
            turns={turns}
            approvals={activeSessionApprovals}
            takeoverPresets={takeoverPresets}
            takeoverState={takeoverState}
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
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
};
