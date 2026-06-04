import type {
  ChatSession,
  Conversation,
  MessageBlock,
  SessionRelation,
  SessionStatus,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import {
  appendLimitedStreamText,
  parseChatSession,
  parseConversation,
  parseMessageBlock,
  parseSessionRelation,
  parseTerminalStream,
  parseToolCall,
  parseTurn
} from "@another-workbench/shared";
import { isPathInsideWorkspace } from "@another-workbench/shared";
import type { Thread } from "./codex-app-server-generated/v2/Thread.js";
import type { CodexErrorInfo } from "./codex-app-server-generated/v2/CodexErrorInfo.js";
import type { FileUpdateChange } from "./codex-app-server-generated/v2/FileUpdateChange.js";
import type { ThreadItem } from "./codex-app-server-generated/v2/ThreadItem.js";
import type { SessionSource } from "./codex-app-server-generated/v2/SessionSource.js";
import type { UserInput } from "./codex-app-server-generated/v2/UserInput.js";
import { pathToFileURL } from "node:url";
import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import type {
  SessionIndexEntry,
  SessionIndexStore,
  UpsertSessionIndexInput,
  UpsertSessionRelationInput
} from "./session-index.js";
import type { WorkspaceRecord, WorkspaceRegistryService } from "./workspace-registry.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  CodexTurnChangesStore,
  getRecordedCodexTurnChanges,
  recordCodexTurnChangesFromFileUpdate
} from "./engine-extensions/codex/turn-changes-store.js";
import {
  isCodexContextCompactionThreadItem,
  isCodexImageGenerationThreadItem,
  isCodexImageViewThreadItem,
  isCodexReasoningThreadItem,
  isCodexWebSearchThreadItem,
  mapCodexResponseItemStatus,
  summarizeCodexImageGenerationInput,
  summarizeCodexImageGenerationOutput,
  summarizeCodexImageViewInput,
  summarizeCodexImageViewOutput,
  summarizeCodexReasoningThreadItem,
  summarizeCodexWebSearchAction
} from "./engine-extensions/codex/process-activity.js";
import {
  consumeCodexRolloutTimestamp,
  type CodexRolloutTimestampGroup,
  readCodexRolloutTimestampGroups,
  resolveCodexThreadItemTimestamp
} from "./engine-extensions/codex/rollout-timestamps.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";

const codexProviderKind = "codex-thread";
const codexAgentId = "codex";

const isoFromUnixSeconds = (value: number): string =>
  new Date(value * 1_000).toISOString();

const discoveredCodexSessionId = (threadId: string): string => `codex-thread:${threadId}`;

const discoveredConversationId = (rootSessionId: string): string =>
  `conversation-discovered:${rootSessionId}`;

const trimToUndefined = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const summarizeThread = (thread: Thread): string | undefined =>
  trimToUndefined(thread.preview) ?? trimToUndefined(thread.name);

const titleForThread = (thread: Thread): string =>
  trimToUndefined(thread.name) ??
  trimToUndefined(thread.preview)?.split("\n").map((line) => line.trim()).find(Boolean) ??
  discoveredCodexSessionId(thread.id);

const mapThreadStatus = (thread: Thread): SessionStatus => {
  switch (thread.status.type) {
    case "active":
      return "running";
    case "systemError":
      return "error";
    case "idle":
    case "notLoaded":
    default:
      return "idle";
  }
};

const toSubagentParentThreadId = (source: SessionSource): string | undefined => {
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return undefined;
  }
  const subAgentSource = source.subAgent;
  if (
    !subAgentSource ||
    typeof subAgentSource !== "object" ||
    !("thread_spawn" in subAgentSource)
  ) {
    return undefined;
  }
  return trimToUndefined(subAgentSource.thread_spawn.parent_thread_id);
};

const buildDeterministicTurnTimestamp = (
  thread: Thread,
  turnIndex: number,
  itemIndex = 0
): string => new Date((thread.createdAt + turnIndex * 60 + itemIndex) * 1_000).toISOString();

const buildRelationId = (parentSessionId: string, childSessionId: string): string =>
  `relation-discovered:${parentSessionId}:${childSessionId}:subagent`;

const lastTimestamp = (timestamps: string[]): string | undefined => {
  let latest: string | undefined;
  for (const timestamp of timestamps) {
    if (!latest || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
};

const resolveThreadTurnItemStartedAts = (
  thread: Thread,
  turnIndex: number,
  rolloutTimestampGroups: readonly CodexRolloutTimestampGroup[] = []
): string[] => {
  const turn = thread.turns[turnIndex];
  if (!turn) {
    return [];
  }
  const rolloutTimestampGroup = resolveRolloutTimestampGroup(
    turn,
    turnIndex,
    rolloutTimestampGroups
  );
  const rolloutTimestamps = [...(rolloutTimestampGroup?.items ?? [])];
  return turn.items.map(
    (item, itemIndex) =>
      resolveCodexThreadItemTimestamp(item) ??
      consumeCodexRolloutTimestamp(rolloutTimestamps, item.type) ??
      buildDeterministicTurnTimestamp(thread, turnIndex, itemIndex)
  );
};

const resolveRolloutTimestampGroup = (
  turn: Thread["turns"][number],
  turnIndex: number,
  rolloutTimestampGroups: readonly CodexRolloutTimestampGroup[]
): CodexRolloutTimestampGroup | undefined =>
  rolloutTimestampGroups.find((group) => group.turnId === turn.id) ??
  rolloutTimestampGroups[turnIndex];

const resolveThreadTurnStartedAt = (
  thread: Thread,
  turnIndex: number,
  itemStartedAts: readonly string[],
  rolloutTimestampGroup?: CodexRolloutTimestampGroup
): string => {
  const fallbackStartedAt = buildDeterministicTurnTimestamp(thread, turnIndex);
  const firstItemStartedAt = itemStartedAts[0];
  if (firstItemStartedAt && firstItemStartedAt !== fallbackStartedAt) {
    return firstItemStartedAt;
  }
  return rolloutTimestampGroup?.startedAt ?? firstItemStartedAt ?? fallbackStartedAt;
};

const resolveThreadTurnCompletedAt = (
  thread: Thread,
  turnIndex: number,
  itemStartedAts: readonly string[],
  rolloutTimestampGroup?: CodexRolloutTimestampGroup
): string | undefined => {
  const turn = thread.turns[turnIndex];
  if (!turn || turn.status === "inProgress") {
    return undefined;
  }
  return (
    rolloutTimestampGroup?.completedAt ??
    lastTimestamp([...itemStartedAts]) ??
    buildDeterministicTurnTimestamp(thread, turnIndex, turn.items.length + 1)
  );
};

const resolveThreadLastCompletedTurnAt = (
  thread: Thread,
  rolloutTimestampGroups: readonly CodexRolloutTimestampGroup[] = []
): string | undefined => {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    if (turn?.status !== "inProgress") {
      const rolloutTimestampGroup = resolveRolloutTimestampGroup(
        turn,
        turnIndex,
        rolloutTimestampGroups
      );
      return resolveThreadTurnCompletedAt(
        thread,
        turnIndex,
        resolveThreadTurnItemStartedAts(thread, turnIndex, rolloutTimestampGroups),
        rolloutTimestampGroup
      );
    }
  }
  return undefined;
};

const isCommandExecutionItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "commandExecution" }> =>
  item.type === "commandExecution";

const isFileChangeItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "fileChange" }> => item.type === "fileChange";

const isCollabAgentToolCallItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "collabAgentToolCall" }> =>
  item.type === "collabAgentToolCall";

const isAgentMessageItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "agentMessage" }> =>
  item.type === "agentMessage";

const isFinalAnswerMessageItem = (
  item: Extract<ThreadItem, { type: "agentMessage" }>
): boolean => item.phase === "final_answer";

const isUserMessageItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "userMessage" }> =>
  item.type === "userMessage";

const hydratedItemId = (sessionId: string, itemId: string): string =>
  `hydrated:${sessionId}:${itemId}`;

const mapCollabToolLabel = (
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"]
): string => {
  switch (tool) {
    case "spawnAgent":
      return "subagent.spawn";
    case "sendInput":
      return "subagent.message";
    case "resumeAgent":
      return "subagent.resume";
    case "wait":
      return "subagent.wait";
    case "closeAgent":
      return "subagent.close";
    default:
      return `subagent.${tool}`;
  }
};

const summarizeCollabInput = (
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): string | undefined => {
  const parts = [
    item.prompt?.trim(),
    item.model ? `model: ${item.model}` : undefined,
    item.reasoningEffort ? `reasoning: ${item.reasoningEffort}` : undefined,
    item.receiverThreadIds.length > 0
      ? `targets: ${item.receiverThreadIds.join(", ")}`
      : undefined
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const summarizeCollabOutput = (
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): string | undefined => {
  const lines = item.receiverThreadIds.map((threadId) => {
    const state = item.agentsStates[threadId];
    if (!state) {
      return `${threadId}: unknown`;
    }
    const detail = trimToUndefined(state.message);
    return detail
      ? `${threadId}: ${state.status} — ${detail}`
      : `${threadId}: ${state.status}`;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
};

const toLocalImageMarkdownUrl = (value: string): string => {
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return pathToFileURL(value).toString();
  }
  if (/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(value)) {
    return value;
  }
  return pathToFileURL(value).toString();
};

const summarizeUserInput = (
  input: UserInput
): string | undefined => {
  switch (input.type) {
    case "text":
      return input.text;
    case "image":
      return `![image](${input.url})`;
    case "localImage":
      return `![image](${toLocalImageMarkdownUrl(input.path)})`;
    case "skill":
      return `skill: ${input.name} (${input.path})`;
    case "mention":
      return `mention: ${input.name} (${input.path})`;
    default:
      return undefined;
  }
};

const summarizeUserMessage = (content: UserInput[]): string =>
  content
    .map((input) => summarizeUserInput(input)?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

const formatCodexErrorInfo = (value: CodexErrorInfo | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  const [key] = Object.keys(value);
  return key ? key : undefined;
};

const formatTurnErrorText = (input: {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails?: string | null;
}): string => {
  const errorCode = formatCodexErrorInfo(input.codexErrorInfo);
  const headline = errorCode
    ? `Runtime error (${errorCode}): ${input.message}`
    : `Runtime error: ${input.message}`;
  const details = trimToUndefined(input.additionalDetails);
  return details ? `${headline}\n\n${details}` : headline;
};

export type DiscoveredSessionRecord = {
  sessionId: string;
  engineId: string;
  providerKind: string;
  providerSessionId: string;
  title: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
  lastCompletedTurnAt?: string;
  archivedAt?: string;
  metadata?: Record<string, unknown>;
};

export type DiscoveredSessionRelation = {
  parentSessionId: string;
  childSessionId: string;
  relationType: "subagent";
  createdAt: string;
};

export type DiscoveredWorkspaceResult = {
  sessions: DiscoveredSessionRecord[];
  relations: DiscoveredSessionRelation[];
};

export type HydratedTurn = Turn & {
  finalMessageId?: string;
};

export type HydratedSessionSnapshot = {
  workspaceId: string;
  conversation: Conversation;
  session: ChatSession;
  turns: HydratedTurn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  sessionRelations: SessionRelation[];
  runtimeBinding?: {
    providerKind: string;
    providerSessionId: string;
  };
};

export type HydratedSessionWindowSnapshot = HydratedSessionSnapshot & {
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
};

export type SessionDiscoveryProvider = {
  readonly engineId: string;
  discoverWorkspace: (workspace: WorkspaceRecord) => Promise<DiscoveredWorkspaceResult>;
  hydrateSession: (
    entry: SessionIndexEntry,
    input?: {
      isCancelled?: () => boolean;
    }
  ) => Promise<HydratedSessionSnapshot | undefined>;
  hydrateSessionWindow?: (
    entry: SessionIndexEntry,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
    }
  ) => Promise<HydratedSessionWindowSnapshot | undefined>;
};

type HydrationConsumer = {
  isCancelled?: () => boolean;
};

type SharedHydrationTask<T> = {
  consumers: Set<HydrationConsumer>;
  promise: Promise<T>;
};

const areAllHydrationConsumersCancelled = (
  consumers: ReadonlySet<HydrationConsumer>
): boolean => {
  if (consumers.size === 0) {
    return false;
  }
  for (const consumer of consumers) {
    if (!consumer.isCancelled?.()) {
      return false;
    }
  }
  return true;
};

const resolveHydratedLastCompletedTurnAt = (
  turns: readonly HydratedTurn[]
): string | undefined => {
  let latestCompletedAt: string | undefined;
  for (const turn of turns) {
    if (turn.status !== "completed" || !turn.completedAt) {
      continue;
    }
    if (!latestCompletedAt || turn.completedAt > latestCompletedAt) {
      latestCompletedAt = turn.completedAt;
    }
  }
  return latestCompletedAt;
};

const latestIso = (
  left: string | undefined,
  right: string | undefined
): string | undefined => {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
};

type HydratedCodexTurnEntities = {
  turns: HydratedTurn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
};

const hydrateCodexTurnEntities = async (input: {
  entry: SessionIndexEntry;
  thread: Thread;
  turnChangesStore?: CodexTurnChangesStore;
  isCancelled?: () => boolean;
}): Promise<HydratedCodexTurnEntities | undefined> => {
  const { entry, thread, turnChangesStore, isCancelled } = input;
  const turns: HydratedTurn[] = [];
  const messageBlocks: MessageBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const terminalStreams: TerminalStream[] = [];
  const rolloutTimestampGroups = await readCodexRolloutTimestampGroups(thread.path);

  for (const [turnIndex, turn] of thread.turns.entries()) {
    if (isCancelled?.()) {
      return undefined;
    }
    const hydratedItems = turn.items;
    const rolloutTimestampGroup = resolveRolloutTimestampGroup(
      turn,
      turnIndex,
      rolloutTimestampGroups
    );
    const itemStartedAts = resolveThreadTurnItemStartedAts(
      thread,
      turnIndex,
      rolloutTimestampGroups
    );
    const startedAt = resolveThreadTurnStartedAt(
      thread,
      turnIndex,
      itemStartedAts,
      rolloutTimestampGroup
    );
    const completedAt = resolveThreadTurnCompletedAt(
      thread,
      turnIndex,
      itemStartedAts,
      rolloutTimestampGroup
    );
    const messageIds: string[] = [];
    const toolCallIds: string[] = [];
    const terminalIds: string[] = [];
    const fileChanges: FileUpdateChange[] = [];
    let finalMessageId: string | undefined;

    for (const [itemIndex, item] of hydratedItems.entries()) {
      if (isCancelled?.()) {
        return undefined;
      }
      const itemStartedAt =
        itemStartedAts[itemIndex] ??
        buildDeterministicTurnTimestamp(thread, turnIndex, itemIndex);
      const itemEntityId = hydratedItemId(entry.sessionId, item.id);
      if (isUserMessageItem(item)) {
        messageIds.push(itemEntityId);
        messageBlocks.push(
          parseMessageBlock({
            blockId: `${itemEntityId}:md`,
            messageId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            role: "user",
            kind: "markdown",
            text: summarizeUserMessage(item.content),
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }
      if (isAgentMessageItem(item)) {
        messageIds.push(itemEntityId);
        if (isFinalAnswerMessageItem(item)) {
          finalMessageId = itemEntityId;
        }
        messageBlocks.push(
          parseMessageBlock({
            blockId: `${itemEntityId}:md`,
            messageId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            role: "assistant",
            phase: item.phase ?? undefined,
            kind: "markdown",
            text: item.text,
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }
      if (isCommandExecutionItem(item)) {
        toolCallIds.push(itemEntityId);
        terminalIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "commandExecution",
            inputSummary: item.command,
            outputSummary: item.aggregatedOutput != null
              ? appendLimitedStreamText(undefined, item.aggregatedOutput)
              : undefined,
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "completed"
                  ? "completed"
                  : "running",
            startedAt: itemStartedAt,
            completedAt:
              item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
        terminalStreams.push(
          parseTerminalStream({
            terminalId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolCallId: itemEntityId,
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "completed"
                  ? "completed"
                  : "running",
            outputText: appendLimitedStreamText(
              undefined,
              item.aggregatedOutput ?? undefined
            ),
            exitCode: item.exitCode ?? undefined,
            startedAt: itemStartedAt,
            completedAt:
              item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
        continue;
      }

      if (isFileChangeItem(item)) {
        fileChanges.push(...item.changes);
        continue;
      }

      if (isCodexReasoningThreadItem(item)) {
        const outputSummary = summarizeCodexReasoningThreadItem(item);
        if (!outputSummary) {
          continue;
        }
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "reasoning",
            inputSummary: "Reasoning",
            outputSummary,
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexWebSearchThreadItem(item)) {
        const inputSummary = summarizeCodexWebSearchAction(item.action, item.query);
        if (!inputSummary) {
          continue;
        }
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "webSearch",
            inputSummary,
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexContextCompactionThreadItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "contextCompaction",
            inputSummary: "compacting...",
            outputSummary: "compaction finished",
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexImageViewThreadItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "imageView",
            inputSummary: summarizeCodexImageViewInput(item),
            outputSummary: summarizeCodexImageViewOutput(item),
            status: "completed",
            startedAt: itemStartedAt,
            completedAt: itemStartedAt
          })
        );
        continue;
      }

      if (isCodexImageGenerationThreadItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: "imageGeneration",
            inputSummary: summarizeCodexImageGenerationInput(item),
            outputSummary: summarizeCodexImageGenerationOutput(item),
            status:
              item.status === "inProgress"
                ? "running"
                : mapCodexResponseItemStatus(item.status),
            startedAt: itemStartedAt,
            completedAt: item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
        continue;
      }

      if (isCollabAgentToolCallItem(item)) {
        toolCallIds.push(itemEntityId);
        toolCalls.push(
          parseToolCall({
            toolCallId: itemEntityId,
            sessionId: entry.sessionId,
            turnId: turn.id,
            toolName: mapCollabToolLabel(item.tool),
            inputSummary: summarizeCollabInput(item),
            outputSummary: summarizeCollabOutput(item),
            status:
              item.status === "failed"
                ? "failed"
                : item.status === "completed"
                  ? "completed"
                  : "running",
            startedAt: itemStartedAt,
            completedAt:
              item.status === "inProgress" ? undefined : itemStartedAt
          })
        );
      }
    }

    if (turn.error) {
      const errorMessageId = `runtime-error:${turn.id}`;
      messageIds.push(errorMessageId);
      messageBlocks.push(
        parseMessageBlock({
          blockId: `${errorMessageId}:md`,
          messageId: errorMessageId,
          sessionId: entry.sessionId,
          turnId: turn.id,
          role: "system",
          kind: "markdown",
          text: formatTurnErrorText(turn.error),
          startedAt: completedAt ?? startedAt,
          completedAt: completedAt ?? startedAt
        })
      );
    }

    recordCodexTurnChangesFromFileUpdate({
      sessionId: entry.sessionId,
      turnId: turn.id,
      changes: fileChanges
    });
    const turnChanges = getRecordedCodexTurnChanges(entry.sessionId, turn.id);
    if (turnChanges) {
      turnChangesStore?.record(turnChanges);
    }

    const hydratedTurn = parseTurn({
      turnId: turn.id,
      sessionId: entry.sessionId,
      status: turn.status === "inProgress" ? "streaming" : "completed",
      finishReason:
        turn.status === "failed"
          ? "failed"
          : turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "completed"
              ? "completed"
              : undefined,
      startedAt,
      completedAt,
      messageIds,
      toolCallIds,
      terminalIds,
      approvalRequestIds: []
    });

    turns.push({
      ...hydratedTurn,
      ...(finalMessageId ? { finalMessageId } : {})
    });
  }

  return {
    turns,
    messageBlocks,
    toolCalls,
    terminalStreams
  };
};

export class CodexSessionDiscoveryProvider implements SessionDiscoveryProvider {
  public readonly engineId = codexAgentId;

  private readonly codexRuntimePort: CodexAppServerRuntimePort;
  private readonly turnChangesStore: CodexTurnChangesStore | undefined;

  public constructor(options: {
    codexRuntimePort: CodexAppServerRuntimePort;
    turnChangesStore?: CodexTurnChangesStore;
  }) {
    this.codexRuntimePort = options.codexRuntimePort;
    this.turnChangesStore = options.turnChangesStore;
  }

  public async discoverWorkspace(
    workspace: WorkspaceRecord
  ): Promise<DiscoveredWorkspaceResult> {
    const threads = (await this.listAllThreads()).filter((thread) =>
      isPathInsideWorkspace(thread.cwd, workspace.absolutePath)
    );
    const sessions: DiscoveredSessionRecord[] = [];
    for (const thread of threads) {
      sessions.push(
        await this.toDiscoveredSessionRecord(
          await this.readThreadWithTurnsForDiscovery(thread)
        )
      );
    }
    const relations = threads
      .flatMap((thread) => {
        const parentThreadId = toSubagentParentThreadId(thread.source);
        if (!parentThreadId) {
          return [];
        }
        return [
          {
            parentSessionId: discoveredCodexSessionId(parentThreadId),
            childSessionId: discoveredCodexSessionId(thread.id),
            relationType: "subagent" as const,
            createdAt: isoFromUnixSeconds(thread.createdAt)
          }
        ];
      })
      .filter((relation) =>
        sessions.some((session) => session.sessionId === relation.parentSessionId)
      );

    return {
      sessions,
      relations
    };
  }

  public async hydrateSession(
    entry: SessionIndexEntry,
    input: {
      isCancelled?: () => boolean;
    } = {}
  ): Promise<HydratedSessionSnapshot | undefined> {
    const threadId = entry.providerSessionId;
    if (!threadId) {
      return undefined;
    }
    const thread = await this.codexRuntimePort.resumeThread(threadId);
    if (input.isCancelled?.()) {
      return undefined;
    }
    this.codexRuntimePort.attachThreadToSession(entry.sessionId, thread.id);
    const workspaceId = entry.workspaceId;
    const conversation = parseConversation({
      conversationId: entry.conversationId,
      workspaceId,
      participantEngineIds: [codexAgentId],
      activeSessionId: entry.sessionId,
      sessionIds: [entry.sessionId],
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt)
    });
    const session = parseChatSession({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      engineId: codexAgentId,
      status: mapThreadStatus(thread),
      title: entry.title ?? titleForThread(thread),
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt),
      archivedAt: entry.archivedAt,
      lastTurnId: thread.turns.at(-1)?.id,
      metadata: {
        ...(entry.metadata ?? {}),
        providerKind: codexProviderKind,
        providerSessionId: thread.id,
        rolloutPath: thread.path ?? undefined,
        cwd: thread.cwd
      }
    });

    const hydratedTurns = await hydrateCodexTurnEntities({
      entry,
      thread,
      turnChangesStore: this.turnChangesStore,
      isCancelled: input.isCancelled
    });
    if (!hydratedTurns) {
      return undefined;
    }
    const { turns, messageBlocks, toolCalls, terminalStreams } = hydratedTurns;

    const sessionRelations = this.buildHydratedRelations(thread);

    return {
      workspaceId,
      conversation,
      session,
      turns,
      messageBlocks,
      toolCalls,
      terminalStreams,
      sessionRelations,
      runtimeBinding: {
        providerKind: codexProviderKind,
        providerSessionId: thread.id
      }
    };
  }

  public async hydrateSessionWindow(
    entry: SessionIndexEntry,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
    }
  ): Promise<HydratedSessionWindowSnapshot | undefined> {
    const threadId = entry.providerSessionId;
    if (!threadId) {
      return undefined;
    }
    const anchorTurnId = input.cursor ? undefined : input.anchorTurnId;
    const cursor =
      input.cursor ??
      (anchorTurnId
        ? JSON.stringify({
            turnId: anchorTurnId,
            includeAnchor: true
          })
        : null);
    const [thread, turnsPage] = await Promise.all([
      this.codexRuntimePort.readThread(threadId, false),
      this.codexRuntimePort.listThreadTurns({
        threadId,
        cursor,
        limit: input.limit,
        sortDirection: "desc",
        itemsView: "full"
      })
    ]);
    if (input.isCancelled?.()) {
      return undefined;
    }
    const pageThread: Thread = {
      ...thread,
      turns: turnsPage.data
    };
    this.codexRuntimePort.attachThreadToSession(entry.sessionId, thread.id);
    const workspaceId = entry.workspaceId;
    const conversation = parseConversation({
      conversationId: entry.conversationId,
      workspaceId,
      participantEngineIds: [codexAgentId],
      activeSessionId: entry.sessionId,
      sessionIds: [entry.sessionId],
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt)
    });
    const session = parseChatSession({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      engineId: codexAgentId,
      status: mapThreadStatus(thread),
      title: entry.title ?? titleForThread(thread),
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt),
      archivedAt: entry.archivedAt,
      lastTurnId: entry.lastTurnId ?? turnsPage.data[0]?.id,
      metadata: {
        ...(entry.metadata ?? {}),
        providerKind: codexProviderKind,
        providerSessionId: thread.id,
        rolloutPath: thread.path ?? undefined,
        cwd: thread.cwd
      }
    });
    const hydratedTurns = await hydrateCodexTurnEntities({
      entry,
      thread: pageThread,
      turnChangesStore: this.turnChangesStore,
      isCancelled: input.isCancelled
    });
    if (!hydratedTurns) {
      return undefined;
    }
    const { turns, messageBlocks, toolCalls, terminalStreams } = hydratedTurns;

    return {
      workspaceId,
      conversation,
      session,
      turns,
      messageBlocks,
      toolCalls,
      terminalStreams,
      sessionRelations: this.buildHydratedRelations(thread),
      hasOlder: Boolean(turnsPage.nextCursor),
      hasNewer: Boolean(input.cursor),
      olderCursor: turnsPage.nextCursor ?? undefined,
      newerCursor: turnsPage.backwardsCursor ?? undefined,
      runtimeBinding: {
        providerKind: codexProviderKind,
        providerSessionId: thread.id
      }
    };
  }

  private async listAllThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.codexRuntimePort.listThreads({
        cursor,
        archived: false
      });
      threads.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return threads;
  }

  private async readThreadWithTurnsForDiscovery(thread: Thread): Promise<Thread> {
    if (thread.turns.length > 0) {
      return thread;
    }
    try {
      return await this.codexRuntimePort.readThread(thread.id, true);
    } catch {
      return thread;
    }
  }

  private async toDiscoveredSessionRecord(thread: Thread): Promise<DiscoveredSessionRecord> {
    const rolloutTimestampGroups = await readCodexRolloutTimestampGroups(thread.path);
    return {
      sessionId: discoveredCodexSessionId(thread.id),
      engineId: codexAgentId,
      providerKind: codexProviderKind,
      providerSessionId: thread.id,
      title: titleForThread(thread),
      summaryText: summarizeThread(thread),
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt),
      lastCompletedTurnAt: resolveThreadLastCompletedTurnAt(
        thread,
        rolloutTimestampGroups
      ),
      metadata: {
        rolloutPath: thread.path ?? undefined,
        cwd: thread.cwd
      }
    };
  }

  private buildHydratedRelations(thread: Thread): SessionRelation[] {
    const parentThreadId = toSubagentParentThreadId(thread.source);
    if (!parentThreadId) {
      return [];
    }
    const parentSessionId = discoveredCodexSessionId(parentThreadId);
    const childSessionId = discoveredCodexSessionId(thread.id);
    return [
      parseSessionRelation({
        relationId: buildRelationId(parentSessionId, childSessionId),
        parentSessionId,
        childSessionId,
        relationType: "subagent",
        createdAt: isoFromUnixSeconds(thread.createdAt)
      })
    ];
  }
}

export class SessionReconciliationService {
  private readonly workspaceRegistry: WorkspaceRegistryService;
  private readonly sessionIndexStore: SessionIndexStore;
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly providersByEngineId: Map<string, SessionDiscoveryProvider>;
  private readonly sessionIdentity: SessionIdentityRegistry;
  private readonly hydrationBySessionId = new Map<
    string,
    SharedHydrationTask<boolean>
  >();
  private readonly windowHydrationByKey = new Map<
    string,
    SharedHydrationTask<HydratedSessionWindowSnapshot | undefined>
  >();

  public constructor(options: {
    workspaceRegistry: WorkspaceRegistryService;
    sessionIndexStore: SessionIndexStore;
    runtimeService: WorkbenchRuntimeService;
    sessionIdentity?: SessionIdentityRegistry;
    capabilityRegistry?: CapabilityRegistry;
    providers?: SessionDiscoveryProvider[];
  }) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.runtimeService = options.runtimeService;
    this.sessionIdentity =
      options.sessionIdentity ??
      new SessionIdentityRegistry({
        runtimeService: options.runtimeService,
        sessionIndexStore: options.sessionIndexStore
      });
    this.providersByEngineId = new Map(
      (options.providers ?? options.capabilityRegistry?.listSessionDiscoveryProviders() ?? []).map(
        (provider) => [provider.engineId, provider] as const
      )
    );
  }

  public async reconcileWorkspace(workspaceId?: string): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    await this.workspaceRegistry.ready();
    await this.sessionIndexStore.ready();
    const workspaces = this.workspaceRegistry
      .listWorkspaces()
      .filter((workspace) => !workspaceId || workspace.workspaceId === workspaceId);

    let sessionCount = 0;
    let relationCount = 0;

    for (const workspace of workspaces) {
      for (const provider of this.providersByEngineId.values()) {
        const discovered = await provider.discoverWorkspace(workspace);
        const sessionIdAliases = this.buildSessionIdAliases(
          workspace.workspaceId,
          discovered.sessions
        );
        const normalizedSessions = discovered.sessions.map((session) => ({
          ...session,
          sessionId: sessionIdAliases.get(session.sessionId) ?? session.sessionId
        }));
        const normalizedRelations = discovered.relations.map((relation) => ({
          ...relation,
          parentSessionId:
            sessionIdAliases.get(relation.parentSessionId) ?? relation.parentSessionId,
          childSessionId:
            sessionIdAliases.get(relation.childSessionId) ?? relation.childSessionId
        }));
        const conversationIdBySessionId = buildConversationMap(
          normalizedSessions,
          normalizedRelations
        );
        const entries: UpsertSessionIndexInput[] = normalizedSessions.map((session) => ({
          workspaceId: workspace.workspaceId,
          session: {
            sessionId: session.sessionId,
            conversationId:
              conversationIdBySessionId.get(session.sessionId) ??
              discoveredConversationId(session.sessionId),
            engineId: session.engineId,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            archivedAt: session.archivedAt,
            metadata: session.metadata
          },
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId,
          summaryText: session.summaryText,
          lastCompletedTurnAt: session.lastCompletedTurnAt,
          source: "reconciled"
        }));
        const relations: UpsertSessionRelationInput[] = normalizedRelations.map((relation) => ({
          workspaceId: workspace.workspaceId,
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType,
          createdAt: relation.createdAt
        }));

        const result = await this.sessionIndexStore.reconcileWorkspace({
          workspaceId: workspace.workspaceId,
          entries,
          relations
        });
        const discoveredProviderSessionIds = new Set(
          discovered.sessions.map((session) => session.providerSessionId)
        );
        const staleReconciledSessionIds = this.sessionIndexStore
          .listEntries(workspace.workspaceId)
          .filter(
            (entry) =>
              entry.engineId === provider.engineId &&
              entry.source === "reconciled" &&
              !entry.archivedAt &&
              Boolean(entry.providerSessionId) &&
              !discoveredProviderSessionIds.has(entry.providerSessionId!)
          )
          .map((entry) => entry.sessionId);
        if (staleReconciledSessionIds.length > 0) {
          await this.sessionIndexStore.archiveSessions(staleReconciledSessionIds);
        }
        sessionCount += result.sessionCount;
        relationCount += result.relationCount;
      }
    }

    return {
      workspaces: workspaces.length,
      sessions: sessionCount,
      relations: relationCount
    };
  }

  private buildSessionIdAliases(
    workspaceId: string,
    sessions: DiscoveredSessionRecord[]
  ): Map<string, string> {
    const aliases = new Map<string, string>();

    for (const session of sessions) {
      const existingSessionId = this.sessionIdentity.resolveWorkbenchSessionId(
        {
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId
        },
        workspaceId
      );
      if (existingSessionId) {
        aliases.set(session.sessionId, existingSessionId);
      }
    }

    return aliases;
  }

  public async ensureSessionLoaded(
    sessionId: string,
    input: {
      isCancelled?: () => boolean;
      force?: boolean;
    } = {}
  ): Promise<boolean> {
    const loaded = this.runtimeService
      .listSessions({ includeArchived: true })
      .some((session) => session.sessionId === sessionId);
    if (loaded && !input.force) {
      return true;
    }

    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return false;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider) {
      return false;
    }
    const consumer: HydrationConsumer = {
      isCancelled: input.isCancelled
    };
    const existingHydration = this.hydrationBySessionId.get(sessionId);
    if (existingHydration) {
      existingHydration.consumers.add(consumer);
      const loadedByExisting = await existingHydration.promise;
      return input.isCancelled?.() ? false : loadedByExisting;
    }
    const consumers = new Set<HydrationConsumer>([consumer]);
    const hydration: SharedHydrationTask<boolean> = {
      consumers,
      promise: this.hydrateSessionEntry(entry, provider, {
        isCancelled: () => areAllHydrationConsumersCancelled(consumers)
      }).finally(() => {
        this.hydrationBySessionId.delete(sessionId);
      })
    };
    this.hydrationBySessionId.set(sessionId, hydration);
    const loadedByHydration = await hydration.promise;
    return input.isCancelled?.() ? false : loadedByHydration;
  }

  public async hydrateSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
    }
  ): Promise<HydratedSessionWindowSnapshot | undefined> {
    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return undefined;
    }
    const provider = this.providersByEngineId.get(entry.engineId);
    if (!provider?.hydrateSessionWindow) {
      return undefined;
    }
    const anchorTurnId = input.cursor ? undefined : input.anchorTurnId;
    const hydrationKey = `${sessionId}\u0000${input.cursor ?? ""}\u0000${
      anchorTurnId ?? ""
    }\u0000${input.limit}`;
    const consumer: HydrationConsumer = {
      isCancelled: input.isCancelled
    };
    const existingHydration = this.windowHydrationByKey.get(hydrationKey);
    if (existingHydration) {
      existingHydration.consumers.add(consumer);
      const hydrated = await existingHydration.promise;
      return input.isCancelled?.() ? undefined : hydrated;
    }
    const consumers = new Set<HydrationConsumer>([consumer]);
    const hydration: SharedHydrationTask<
      HydratedSessionWindowSnapshot | undefined
    > = {
      consumers,
      promise: provider
        .hydrateSessionWindow(entry, {
          limit: input.limit,
          cursor: input.cursor,
          anchorTurnId,
          isCancelled: () => areAllHydrationConsumersCancelled(consumers)
        })
        .then(async (hydrated) => {
          if (!hydrated || areAllHydrationConsumersCancelled(consumers)) {
            return undefined;
          }
          this.runtimeService.hydrateDiscoveredSession(hydrated, {
            relatedIndexRelations: this.sessionIndexStore
              .listRelations(entry.workspaceId)
              .filter(
                (relation) =>
                  relation.parentSessionId === sessionId ||
                  relation.childSessionId === sessionId
              )
          });
          await this.upsertHydratedSession(entry, hydrated, {
            partial: true
          });
          return hydrated;
        })
        .finally(() => this.windowHydrationByKey.delete(hydrationKey))
    };
    this.windowHydrationByKey.set(hydrationKey, hydration);
    const hydrated = await hydration.promise;
    if (!hydrated || input.isCancelled?.()) {
      return undefined;
    }
    return hydrated;
  }

  private async hydrateSessionEntry(
    entry: SessionIndexEntry,
    provider: SessionDiscoveryProvider,
    input: {
      isCancelled?: () => boolean;
    } = {}
  ): Promise<boolean> {
    const hydrated = await provider.hydrateSession(entry, {
      isCancelled: input.isCancelled
    });
    if (!hydrated || input.isCancelled?.()) {
      return false;
    }
    this.runtimeService.hydrateDiscoveredSession(hydrated, {
      relatedIndexRelations: this.sessionIndexStore
        .listRelations(entry.workspaceId)
        .filter(
          (relation) =>
            relation.parentSessionId === entry.sessionId ||
            relation.childSessionId === entry.sessionId
        )
    });
    await this.upsertHydratedSession(entry, hydrated);
    return true;
  }

  private async upsertHydratedSession(
    entry: SessionIndexEntry,
    hydrated: HydratedSessionSnapshot,
    input: {
      partial?: boolean;
    } = {}
  ): Promise<void> {
    const hydratedLastCompletedTurnAt = resolveHydratedLastCompletedTurnAt(hydrated.turns);
    await this.sessionIndexStore.upsertSession({
      workspaceId: hydrated.workspaceId,
      session: hydrated.session,
      providerKind: hydrated.runtimeBinding?.providerKind ?? entry.providerKind,
      providerSessionId:
        hydrated.runtimeBinding?.providerSessionId ?? entry.providerSessionId,
      summaryText: entry.summaryText,
      lastCompletedTurnAt: input.partial
        ? latestIso(entry.lastCompletedTurnAt, hydratedLastCompletedTurnAt)
        : hydratedLastCompletedTurnAt,
      unreadState: entry.unreadState,
      source: entry.source
    });
  }
}

const buildConversationMap = (
  sessions: DiscoveredSessionRecord[],
  relations: DiscoveredSessionRelation[]
): Map<string, string> => {
  const parentByChildId = new Map<string, string>();
  for (const relation of relations) {
    if (!parentByChildId.has(relation.childSessionId)) {
      parentByChildId.set(relation.childSessionId, relation.parentSessionId);
    }
  }

  const conversationIdBySessionId = new Map<string, string>();
  const resolveRoot = (sessionId: string): string => {
    const seen = new Set<string>();
    let current = sessionId;
    while (parentByChildId.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentByChildId.get(current) ?? current;
    }
    return current;
  };

  for (const session of sessions) {
    const rootSessionId = resolveRoot(session.sessionId);
    conversationIdBySessionId.set(
      session.sessionId,
      discoveredConversationId(rootSessionId)
    );
  }
  return conversationIdBySessionId;
};
