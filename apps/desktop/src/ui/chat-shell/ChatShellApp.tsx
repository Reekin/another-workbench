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
  EngineModelCatalogRpc,
  EngineSurfaceRpc,
  RuntimeInteraction,
  WorkbenchSettingsRpc,
  Turn,
  SessionWindowRpc
} from "@another-workbench/shared";
import "xterm/css/xterm.css";
import type { RendererStore } from "../../store/store.js";
import type {
  DesktopTransport,
  EventBacklogPressure
} from "../../transport/desktop-transport.js";
import { connectDesktopTransportToStore } from "../../transport/store-bridge.js";
import { renderTurnExtensions } from "../../features/engine-extensions/turn-extension-registry.js";
import { Button } from "./Button.js";
import { ChatTreePanel } from "./ChatTreePanel.js";
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
import {
  filterComposerTurnsForChatTree,
  filterTranscriptRowsForChatTree
} from "./chat-tree-transcript.js";
import { buildTurnTranscriptRows } from "./transcript-view-model.js";
import {
  useRendererConversationRevision,
  useRendererSessionRevision,
  useRendererStoreState
} from "./use-renderer-store-state.js";
import {
  findActiveSessionNode,
  findSessionNode,
  projectSessionBrowserPresentation,
  type AttentionSessionViewNode,
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
import type { ComposerExecutionSelection } from "./composer/composer-types.js";
import "./chat-shell.css";

type SettingsLauncherProps = {
  engines: EngineDefinitionRpc[];
  surfacesByEngineId: Readonly<Record<string, EngineSurfaceRpc | undefined>>;
  transport?: DesktopTransport;
  settings: WorkbenchSettingsRpc;
  onSettingsSaved: (settings: WorkbenchSettingsRpc) => void;
  onStatusNotice: (notice: ComposerStatusNotice) => void;
};


const autoRefreshBacklogCooldownMs = 30_000;
const autoRefreshBacklogStreamThreshold = 500;

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

type TranscriptRow = ReturnType<typeof buildTurnTranscriptRows>[number];
type RenderedTurnGroup = {
  visibleRow: TranscriptRow;
  hiddenRows: TranscriptRow[];
};
type WorkspaceMenuAction = "open_directory" | "remove_workspace";
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
const resolveLastExecutionPreference = (
  profile: WorkbenchSettingsRpc["lastExecutionByEngineId"][string] | undefined
): ComposerExecutionSelection | undefined =>
  profile?.modelId
    ? {
        modelId: profile.modelId,
        reasoningOptionId: profile.reasoningOptionId,
        serviceTierId: profile.serviceTierId
      }
    : undefined;
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
                  {visibleRow.blocks.map((block, blockIndex) => (
                    <MessageMarkdownView
                      key={block.blockId}
                      block={block}
                      copyBlocks={
                        blockIndex === visibleRow.blocks.length - 1
                          ? visibleRow.blocks
                          : undefined
                      }
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
    previous.onPreviewImage === next.onPreviewImage
);

const SettingsLauncher = ({
  engines,
  surfacesByEngineId,
  transport,
  settings,
  onSettingsSaved,
  onStatusNotice
}: SettingsLauncherProps): ReactElement => {
  const [isOpen, setIsOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState(() => structuredClone(settings));
  const [activePage, setActivePage] = useState<"general" | "models">("general");
  const [modelCatalogsByEngineId, setModelCatalogsByEngineId] = useState<
    Record<string, EngineModelCatalogRpc | undefined>
  >({});
  const [modelCatalogErrorsByEngineId, setModelCatalogErrorsByEngineId] = useState<
    Record<string, string | undefined>
  >({});
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const selectedSettingsEngineId =
    draftSettings.defaultNewSessionEngineId ?? engines[0]?.engineId ?? "";
  const selectedEngineProgramPath =
    draftSettings.engineProgramPathsByEngineId[selectedSettingsEngineId] ?? "";
  const savedEngineProgramPath =
    settings.engineProgramPathsByEngineId[selectedSettingsEngineId] ?? "";
  const selectedEngineProgramResolution =
    settings.engineProgramResolutionsByEngineId[selectedSettingsEngineId];
  const isClearingEngineProgramPath =
    Boolean(savedEngineProgramPath) && !selectedEngineProgramPath;
  const displayedEngineProgramPath = isClearingEngineProgramPath
    ? ""
    : selectedEngineProgramPath || selectedEngineProgramResolution?.path || "";
  const engineInspector = useMemo(
    () =>
      buildEngineInspectorViewModel({
        selectedEngineId: draftSettings.defaultNewSessionEngineId ?? "",
        engines,
        surfacesByEngineId
      }),
    [draftSettings.defaultNewSessionEngineId, engines, surfacesByEngineId]
  );
  const modelEngines = useMemo(
    () =>
      engines.filter((engine) =>
        surfacesByEngineId[engine.engineId]?.sharedCapabilities.includes(
          "turnConfiguration"
        )
      ),
    [engines, surfacesByEngineId]
  );

  useEffect(() => {
    if (!isOpen || !transport || activePage !== "models" || modelEngines.length === 0) {
      return;
    }
    let cancelled = false;
    setIsLoadingModels(true);
    void Promise.all(
      modelEngines.map(async (engine) => {
        try {
          return {
            engineId: engine.engineId,
            catalog: await transport.engine.listModels(engine.engineId)
          };
        } catch (error) {
          return { engineId: engine.engineId, error: (error as Error).message };
        }
      })
    ).then((results) => {
      if (!cancelled) {
        setModelCatalogsByEngineId(
          Object.fromEntries(results.map((result) => [result.engineId, result.catalog]))
        );
        setModelCatalogErrorsByEngineId(
          Object.fromEntries(results.map((result) => [result.engineId, result.error]))
        );
        setIsLoadingModels(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activePage, isOpen, modelEngines, transport]);

  const close = (): void => {
    setIsOpen(false);
  };

  const open = (): void => {
    setDraftSettings(structuredClone(settings));
    setActivePage("general");
    setIsOpen(true);
  };

  const parseReasoningOptionIds = (value: string): string[] =>
    Array.from(
      new Set(
        value
          .split(/[\s,]+/)
          .map((optionId) => optionId.trim())
          .filter(Boolean)
      )
    );

  const toggleCatalogModel = (engineId: string, modelId: string): void => {
    const catalogIds = modelCatalogsByEngineId[engineId]?.models.map(
      (model) => model.modelId
    ) ?? [];
    setDraftSettings((current) => {
      const configuredIds = current.allowedModelIdsByEngineId[engineId] ?? [];
      const effectiveIds = configuredIds.length > 0 ? configuredIds : catalogIds;
      const nextIds = effectiveIds.includes(modelId)
        ? effectiveIds.filter((candidate) => candidate !== modelId)
        : [...effectiveIds, modelId];
      return {
        ...current,
        allowedModelIdsByEngineId: {
          ...current.allowedModelIdsByEngineId,
          [engineId]: nextIds
        }
      };
    });
  };

  const addCustomModel = (engineId: string, form: HTMLFormElement): void => {
    const formData = new FormData(form);
    const modelId = String(formData.get("modelId") ?? "").trim();
    if (!modelId) {
      return;
    }
    setDraftSettings((current) => {
      const configuredIds = current.allowedModelIdsByEngineId[engineId] ?? [];
      const catalogIds = modelCatalogsByEngineId[engineId]?.models.map(
        (model) => model.modelId
      ) ?? [];
      const baseIds = configuredIds.length > 0 ? configuredIds : catalogIds;
      return {
        ...current,
        allowedModelIdsByEngineId: {
          ...current.allowedModelIdsByEngineId,
          [engineId]: Array.from(new Set([...baseIds, modelId]))
        },
        customModelReasoningOptionIdsByEngineId: {
          ...current.customModelReasoningOptionIdsByEngineId,
          [engineId]: {
            ...(current.customModelReasoningOptionIdsByEngineId[engineId] ?? {}),
            [modelId]: parseReasoningOptionIds(
              String(formData.get("reasoningOptions") ?? "")
            )
          }
        }
      };
    });
    form.reset();
  };

  const removeConfiguredModel = (engineId: string, modelId: string): void => {
    setDraftSettings((current) => {
      const nextEngineOptions = {
        ...(current.customModelReasoningOptionIdsByEngineId[engineId] ?? {})
      };
      delete nextEngineOptions[modelId];
      return {
        ...current,
        allowedModelIdsByEngineId: {
          ...current.allowedModelIdsByEngineId,
          [engineId]: (current.allowedModelIdsByEngineId[engineId] ?? []).filter(
            (candidate) => candidate !== modelId
          )
        },
        customModelReasoningOptionIdsByEngineId: {
          ...current.customModelReasoningOptionIdsByEngineId,
          [engineId]: nextEngineOptions
        }
      };
    });
  };

  const setEngineProgramPath = (path?: string): void => {
    if (!selectedSettingsEngineId) {
      return;
    }
    setDraftSettings((current) => {
      const paths = { ...current.engineProgramPathsByEngineId };
      if (path) {
        paths[selectedSettingsEngineId] = path;
      } else {
        delete paths[selectedSettingsEngineId];
      }
      return { ...current, engineProgramPathsByEngineId: paths };
    });
  };

  const pickEngineProgramPath = async (): Promise<void> => {
    const picker = window.workbenchDesktop?.pickEngineProgramPath;
    if (!picker || !selectedSettingsEngineId) {
      return;
    }
    try {
      const result = await picker(selectedSettingsEngineId);
      if (!result.canceled && result.path) {
        setEngineProgramPath(result.path);
      }
    } catch (error) {
      onStatusNotice({
        message: `Program selection failed: ${(error as Error).message}`,
        persistent: true,
        source: "settings",
        ...statusNoticeErrorDetails(error)
      });
    }
  };

  const engineProgramSourceLabel = (() => {
    if (selectedEngineProgramPath) {
      return "Custom path. This takes priority over environment variables.";
    }
    if (isClearingEngineProgramPath) {
      return "Custom path will be cleared when settings are saved.";
    }
    if (selectedEngineProgramResolution?.source === "environment") {
      return `Detected from ${selectedEngineProgramResolution.environmentVariable}.`;
    }
    if (selectedEngineProgramResolution?.source === "configured") {
      return "Provided by the application configuration.";
    }
    if (selectedEngineProgramResolution) {
      return "Using the default command from PATH.";
    }
    return "No program resolution is available for this engine.";
  })();

  const onSave = async (): Promise<void> => {
    if (!transport) {
      return;
    }
    setIsSaving(true);
    try {
      const result = await transport.settings.update({
        ...draftSettings,
        defaultNewSessionEngineId:
          draftSettings.defaultNewSessionEngineId || undefined
      });
      onSettingsSaved(result);
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
          <Button variant="ghost" size="sm" onClick={close}>
            Close
          </Button>
        </header>
        <div className="awb-modal__body awb-settings">
          <nav className="awb-settings__tabs" role="tablist" aria-label="Settings pages">
            <button
              type="button"
              role="tab"
              aria-selected={activePage === "general"}
              className={activePage === "general" ? "is-active" : ""}
              onClick={() => setActivePage("general")}
            >
              General
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activePage === "models"}
              className={activePage === "models" ? "is-active" : ""}
              onClick={() => setActivePage("models")}
            >
              Models
            </button>
          </nav>
          {activePage === "general" ? <div className="awb-settings__panel">
            <label className="awb-field">
              <span>New session engine</span>
              <select
                value={draftSettings.defaultNewSessionEngineId ?? ""}
                onChange={(event) =>
                  setDraftSettings((current) => ({
                    ...current,
                    defaultNewSessionEngineId: event.target.value || undefined
                  }))
                }
              >
                <option value="">Follow first available engine</option>
                {engines.map((engine) => (
                  <option key={engine.engineId} value={engine.engineId}>
                    {engine.integrationTier
                      ? `${engine.displayName} (${engine.integrationTier})`
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
            <div className="awb-field awb-engine-program" aria-live="polite">
              <span>Engine program</span>
              <div className="awb-engine-program__controls">
                <input
                  readOnly
                  value={displayedEngineProgramPath}
                  placeholder="No engine program detected"
                  title={displayedEngineProgramPath}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    !window.workbenchDesktop ||
                    !selectedSettingsEngineId
                  }
                  onClick={() => void pickEngineProgramPath()}
                >
                  Browse
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!selectedEngineProgramPath}
                  onClick={() => setEngineProgramPath()}
                >
                  Clear
                </Button>
              </div>
              <span>{engineProgramSourceLabel}</span>
            </div>
          </div> : (
            <div className="awb-settings__panel awb-settings-models">
              <p className="awb-settings-models__help">
                No configured IDs means every model reported by that engine is available.
              </p>
              {modelEngines.length === 0 ? (
                <p className="awb-list__empty">No engine exposes turn configuration.</p>
              ) : modelEngines.map((engine) => {
                const catalog = modelCatalogsByEngineId[engine.engineId];
                const configuredIds =
                  draftSettings.allowedModelIdsByEngineId[engine.engineId] ?? [];
                const catalogIds = new Set(catalog?.models.map((model) => model.modelId) ?? []);
                const addedIds = configuredIds.filter((modelId) => !catalogIds.has(modelId));
                const usesAllCatalogModels = configuredIds.length === 0;
                return (
                  <section key={engine.engineId} className="awb-settings-models__engine">
                    <header>
                      <div>
                        <strong>{engine.displayName}</strong>
                        <span>{usesAllCatalogModels ? "All catalog models" : `${configuredIds.length} configured`}</span>
                      </div>
                      {!usesAllCatalogModels ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDraftSettings((current) => ({
                              ...current,
                              allowedModelIdsByEngineId: {
                                ...current.allowedModelIdsByEngineId,
                                [engine.engineId]: []
                              },
                              customModelReasoningOptionIdsByEngineId: {
                                ...current.customModelReasoningOptionIdsByEngineId,
                                [engine.engineId]: {}
                              }
                            }));
                          }}
                        >
                          Use all
                        </Button>
                      ) : null}
                    </header>
                    {modelCatalogErrorsByEngineId[engine.engineId] ? (
                      <p className="awb-settings-models__error">
                        Catalog unavailable: {modelCatalogErrorsByEngineId[engine.engineId]}
                      </p>
                    ) : null}
                    <div className="awb-settings-models__list">
                      {catalog?.models.map((model) => (
                        <label key={model.modelId} className="awb-settings-models__item">
                          <input
                            type="checkbox"
                            checked={usesAllCatalogModels || configuredIds.includes(model.modelId)}
                            onChange={() => toggleCatalogModel(engine.engineId, model.modelId)}
                          />
                          <span>
                            <strong>{model.displayName}</strong>
                            <code>{model.modelId}</code>
                          </span>
                        </label>
                      ))}
                      {!catalog && isLoadingModels ? (
                        <span className="awb-list__empty">Loading catalog…</span>
                      ) : null}
                    </div>
                    {addedIds.length > 0 ? (
                      <div className="awb-settings-models__unavailable">
                        {addedIds.map((modelId) => (
                          <div key={modelId}>
                            <span className="awb-settings-models__add-tag">Add</span>
                            <code>{modelId}</code>
                            <input
                              aria-label={`Efforts for ${modelId}`}
                              placeholder="low, medium, high"
                              defaultValue={(
                                draftSettings.customModelReasoningOptionIdsByEngineId[
                                  engine.engineId
                                ]?.[
                                  modelId
                                ] ?? []
                              ).join(", ")}
                              onBlur={(event) =>
                                setDraftSettings((current) => ({
                                  ...current,
                                  customModelReasoningOptionIdsByEngineId: {
                                    ...current.customModelReasoningOptionIdsByEngineId,
                                    [engine.engineId]: {
                                      ...(current.customModelReasoningOptionIdsByEngineId[
                                        engine.engineId
                                      ] ?? {}),
                                      [modelId]: parseReasoningOptionIds(
                                        event.target.value
                                      )
                                    }
                                  }
                                }))
                              }
                            />
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => removeConfiguredModel(engine.engineId, modelId)}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <form
                      className="awb-settings-models__custom"
                      onSubmit={(event) => {
                        event.preventDefault();
                        addCustomModel(engine.engineId, event.currentTarget);
                      }}
                    >
                      <input
                        name="modelId"
                        aria-label={`Custom model ID for ${engine.displayName}`}
                        placeholder="Exact model ID"
                      />
                      <input
                        name="reasoningOptions"
                        aria-label={`Efforts for custom model in ${engine.displayName}`}
                        placeholder="Efforts: low, medium, high"
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                      >
                        Add
                      </Button>
                    </form>
                  </section>
                );
              })}
            </div>
          )}
        </div>
        <footer className="awb-modal__footer">
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => void onSave()}
            disabled={isSaving}
          >
            Save
          </Button>
        </footer>
      </section>
    </div>
  ) : null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="awb-sidebar__settings"
        onClick={open}
        aria-label="Open settings"
        title="Settings"
      >
        <span aria-hidden="true">⚙</span>
      </Button>
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
  const [engineProgramSettings, setEngineProgramSettings] = useState({
    engineProgramPathsByEngineId: {} as WorkbenchSettingsRpc["engineProgramPathsByEngineId"],
    engineProgramResolutionsByEngineId:
      {} as WorkbenchSettingsRpc["engineProgramResolutionsByEngineId"]
  });
  const [allowedModelIdsByEngineId, setAllowedModelIdsByEngineId] = useState<
    Record<string, string[]>
  >({});
  const [customModelReasoningOptionIdsByEngineId, setCustomModelReasoningOptionIdsByEngineId] =
    useState<Record<string, Record<string, string[]>>>({});
  const [serviceTierPreferencesByEngineId, setServiceTierPreferencesByEngineId] =
    useState<WorkbenchSettingsRpc["serviceTierPreferencesByEngineId"]>({});
  const serviceTierPreferencesByEngineIdRef =
    useRef<WorkbenchSettingsRpc["serviceTierPreferencesByEngineId"]>({});
  const [lastExecutionByEngineId, setLastExecutionByEngineId] = useState<
    WorkbenchSettingsRpc["lastExecutionByEngineId"]
  >({});
  const lastExecutionByEngineIdRef = useRef<
    WorkbenchSettingsRpc["lastExecutionByEngineId"]
  >({});
  const settingsSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [statusNotice, setStatusNoticeState] = useState<ComposerStatusNotice | undefined>();
  const [sessionWindows, setSessionWindows] = useState<
    Record<string, SessionWindowCoverage | undefined>
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
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxState | undefined>();
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | undefined>();

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

  const onExecutionPreferenceChange = useCallback(
    (
      engineId: string,
      execution: ComposerExecutionSelection,
      options?: { serviceTierChanged?: boolean }
    ): void => {
      const nextExecutions = {
        ...lastExecutionByEngineIdRef.current,
        [engineId]: { ...execution }
      };
      let nextServiceTierPreferences =
        serviceTierPreferencesByEngineIdRef.current;
      if (
        options?.serviceTierChanged &&
        execution.modelId &&
        execution.serviceTierId !== undefined
      ) {
        nextServiceTierPreferences = {
          ...nextServiceTierPreferences,
          [engineId]: {
            ...(nextServiceTierPreferences[engineId] ?? {}),
            [execution.modelId]: execution.serviceTierId
          }
        };
      }
      lastExecutionByEngineIdRef.current = nextExecutions;
      serviceTierPreferencesByEngineIdRef.current =
        nextServiceTierPreferences;
      setLastExecutionByEngineId(nextExecutions);
      setServiceTierPreferencesByEngineId(nextServiceTierPreferences);
      if (!transport) {
        return;
      }
      settingsSaveChainRef.current = settingsSaveChainRef.current
        .then(async () => {
          await transport.settings.update({
            lastExecutionByEngineId: nextExecutions,
            serviceTierPreferencesByEngineId: nextServiceTierPreferences
          });
        })
        .catch((error) => {
          setStatusNotice({
            message: `Model preference save failed: ${(error as Error).message}`,
            source: "settings",
            ...statusNoticeErrorDetails(error)
          });
        });
    },
    [setStatusNotice, transport]
  );

  const flushExecutionPreferenceWrites = useCallback(async (): Promise<void> => {
    await settingsSaveChainRef.current;
  }, []);

  const {
    workspaceTree,
    attentionSessions,
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
  const composerEngineId =
    [activeSession?.engineId, activeSessionNode?.engineId, selectedEngineId].find(
      (engineId) => Boolean(engineId && engineSurfacesById[engineId])
    ) ??
    activeSessionNode?.engineId ??
    activeSession?.engineId ??
    selectedEngineId;
  const activeThreadGoal = activeSessionId
    ? domain.getThreadGoal(activeSessionId)
    : undefined;

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
  const visibleAttentionSessions = attentionSessions.filter((session) =>
    projectSessionBrowserPresentation(session, highlightedSessionId).showInAttention
  );
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
    beforeCreateSession: flushExecutionPreferenceWrites,
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
  const composerTurns = useMemo(
    () => filterComposerTurnsForChatTree(turns, activeChatTree),
    [turns, activeChatTree]
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
        setEngineProgramSettings({
          engineProgramPathsByEngineId: settings.engineProgramPathsByEngineId,
          engineProgramResolutionsByEngineId:
            settings.engineProgramResolutionsByEngineId
        });
        setAllowedModelIdsByEngineId(settings.allowedModelIdsByEngineId ?? {});
        setCustomModelReasoningOptionIdsByEngineId(
          settings.customModelReasoningOptionIdsByEngineId ?? {}
        );
        const serviceTierPreferences =
          settings.serviceTierPreferencesByEngineId ?? {};
        serviceTierPreferencesByEngineIdRef.current =
          serviceTierPreferences;
        setServiceTierPreferencesByEngineId(serviceTierPreferences);
        const lastExecution = settings.lastExecutionByEngineId ?? {};
        lastExecutionByEngineIdRef.current = lastExecution;
        setLastExecutionByEngineId(lastExecution);
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
        actions: ["open_directory", "remove_workspace"]
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

  const renderSessionNode = (
    session: SessionBrowserViewNode,
    depth = 0
  ): ReactElement => {
    const presentation = projectSessionBrowserPresentation(
      session,
      highlightedSessionId
    );
    const statusDot = resolveStatusDotLabel(presentation.statusDot);
    const activityAt = session.activityAt ?? session.lastCompletedTurnAt;
    const activityAge = formatRelativeCompletedTurnAge(activityAt);
    return (
      <li key={session.sessionId} className="awb-tree__item">
        <div
          className={`awb-tree__session ${presentation.isSelected ? "is-active" : ""}`}
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
                {session.title}
              </strong>
              <span className="awb-tree__session-meta">
                <span>{session.engineId}</span>
                {activityAge && activityAt ? (
                  <time dateTime={activityAt} title={formatTimestamp(activityAt)}>
                    {activityAge}
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
                <Button
                  variant="text"
                  size="sm"
                  onClick={() =>
                    void onLoadMoreSessionChildren(
                      session.sessionId,
                      session.workspaceId
                    )
                  }
                >
                  Load more
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </li>
    );
  };

  const renderAttentionSession = (
    session: AttentionSessionViewNode
  ): ReactElement => {
    const presentation = projectSessionBrowserPresentation(
      session,
      highlightedSessionId
    );
    const statusDot = resolveStatusDotLabel(presentation.statusDot);
    const activityAge = formatRelativeCompletedTurnAge(session.activityAt);
    return (
      <li key={session.sessionId} className="awb-tree__item">
        <div
          className={`awb-tree__session awb-attention__session ${
            presentation.isSelected ? "is-active" : ""
          }`}
          onClick={() => void onOpenSession(session.sessionId)}
          onContextMenu={(event) => void onOpenSessionMenu(event, session.sessionId)}
        >
          <div className="awb-tree__session-main">
            {statusDot ? (
              <span className={`awb-tree__dot is-${statusDot}`} />
            ) : (
              <span className="awb-tree__dot-placeholder" />
            )}
            <div className="awb-tree__labels">
              <strong>{session.title}</strong>
              <span className="awb-tree__session-meta">
                <span>
                  {session.workspaceLabel} · {session.engineId}
                </span>
                <span className="awb-attention__badges">
                  {session.isPinned ? <span className="awb-attention__pin">Pinned</span> : null}
                  {activityAge ? <time>{activityAge}</time> : null}
                </span>
              </span>
            </div>
          </div>
        </div>
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

  return (
    <>
      <div className="awb-shell">
        <aside className="awb-shell__sidebar">
          <header className="awb-sidebar__header">
            <span className="awb-sidebar__eyebrow">Another Workbench</span>
            <h1>{title}</h1>
          </header>

          <section className="awb-attention">
            <div className="awb-attention__header">
              <h2>Attention</h2>
              <span>{visibleAttentionSessions.length}</span>
            </div>
            {visibleAttentionSessions.length > 0 ? (
              <ul className="awb-tree__branch awb-attention__list">
                {visibleAttentionSessions.map(renderAttentionSession)}
              </ul>
            ) : (
              <p className="awb-attention__empty">Pinned and active sessions appear here.</p>
            )}
          </section>

          <section className="awb-sidebar__section awb-sidebar__section--grow">
            <div className="awb-sidebar__section-header">
              <h2>Workspaces</h2>
              <Button
                variant="secondary"
                size="md"
                onClick={() => void onAddWorkspace()}
              >
                Add workspace
              </Button>
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
                      <ul
                        className="awb-tree__branch awb-tree__branch--workspace"
                        aria-busy={workspace.isLoadingRoots}
                      >
                        {workspace.sessions.map((session) => renderSessionNode(session))}
                        {workspace.isLoadingRoots && workspace.sessions.length === 0 ? (
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
              transport={transport}
              settings={{
                defaultNewSessionEngineId: selectedEngineId || undefined,
                ...engineProgramSettings,
                allowedModelIdsByEngineId,
                customModelReasoningOptionIdsByEngineId,
                serviceTierPreferencesByEngineId,
                lastExecutionByEngineId
              }}
              onSettingsSaved={(nextSettings) => {
                setSelectedEngineId(nextSettings.defaultNewSessionEngineId ?? "");
                setEngineProgramSettings({
                  engineProgramPathsByEngineId:
                    nextSettings.engineProgramPathsByEngineId,
                  engineProgramResolutionsByEngineId:
                    nextSettings.engineProgramResolutionsByEngineId
                });
                setAllowedModelIdsByEngineId(nextSettings.allowedModelIdsByEngineId);
                setCustomModelReasoningOptionIdsByEngineId(
                  nextSettings.customModelReasoningOptionIdsByEngineId
                );
                serviceTierPreferencesByEngineIdRef.current =
                  nextSettings.serviceTierPreferencesByEngineId;
                setServiceTierPreferencesByEngineId(
                  nextSettings.serviceTierPreferencesByEngineId
                );
                lastExecutionByEngineIdRef.current =
                  nextSettings.lastExecutionByEngineId;
                setLastExecutionByEngineId(nextSettings.lastExecutionByEngineId);
              }}
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
            selectedEngineId={composerEngineId}
            engineSurface={engineSurfacesById[composerEngineId]}
            allowedModelIds={allowedModelIdsByEngineId[composerEngineId]}
            customModelReasoningOptionIds={
              customModelReasoningOptionIdsByEngineId[composerEngineId]
            }
            serviceTierPreferences={
              serviceTierPreferencesByEngineId[composerEngineId]
            }
            lastExecution={resolveLastExecutionPreference(
              lastExecutionByEngineId[composerEngineId]
            )}
            activeWorkspaceId={activeWorkspace?.workspaceId}
            activeWorkspaceRootPath={activeWorkspace?.rootPath}
            turns={composerTurns}
            interruptTurns={turns}
            allowSessionLastTurnFallback={!activeChatTree?.supportsJump}
            approvals={activeSessionApprovals}
            interactions={activeSessionInteractions}
            isOpeningSelectedSession={isOpeningSelectedSession}
            statusNotice={statusNotice}
            onStatusNotice={setStatusNotice}
            onPreviewImage={onPreviewImage}
            onCreateSession={onCreateSession}
            onOpenSession={onOpenSession}
            onRequestTranscriptBottom={viewport.scrollToBottom}
            onExecutionPreferenceChange={onExecutionPreferenceChange}
            onRespondApproval={transport ? onRespondApproval : undefined}
            onRespondInteraction={transport ? onRespondInteraction : undefined}
          />
        </main>

        <aside className="awb-shell__detail" aria-label="Session details">
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
      {workspaceMenuMarkup &&
        (typeof document === "undefined"
          ? workspaceMenuMarkup
          : createPortal(workspaceMenuMarkup, document.body))}
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
};
