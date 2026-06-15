import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { AdapterRuntimePort } from "@another-workbench/adapters";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "@another-workbench/adapters";
import type { AgentAdapterRuntimeConfig } from "@another-workbench/adapters";
import type {
  Attachment,
  CodexHookRunRpc,
  ContextUsage,
  EventType
} from "@another-workbench/shared";
import type { GetAuthStatusParams } from "./codex-app-server-generated/GetAuthStatusParams.js";
import type { GetAuthStatusResponse } from "./codex-app-server-generated/GetAuthStatusResponse.js";
import type { GitDiffToRemoteParams } from "./codex-app-server-generated/GitDiffToRemoteParams.js";
import type { GitDiffToRemoteResponse } from "./codex-app-server-generated/GitDiffToRemoteResponse.js";
import type { AskForApproval } from "./codex-app-server-generated/v2/AskForApproval.js";
import type { Config } from "./codex-app-server-generated/v2/Config.js";
import type { ConfigBatchWriteParams } from "./codex-app-server-generated/v2/ConfigBatchWriteParams.js";
import type { ConfigReadParams } from "./codex-app-server-generated/v2/ConfigReadParams.js";
import type { ConfigReadResponse } from "./codex-app-server-generated/v2/ConfigReadResponse.js";
import type { SandboxMode } from "./codex-app-server-generated/v2/SandboxMode.js";
import type { ReasoningEffort } from "./codex-app-server-generated/ReasoningEffort.js";
import type { ThreadStartResponse } from "./codex-app-server-generated/v2/ThreadStartResponse.js";
import type { Thread } from "./codex-app-server-generated/v2/Thread.js";
import type { ThreadArchiveParams } from "./codex-app-server-generated/v2/ThreadArchiveParams.js";
import type { ChatTreeReadParams } from "./codex-app-server-generated/v2/ChatTreeReadParams.js";
import type { ChatTreeReadResponse } from "./codex-app-server-generated/v2/ChatTreeReadResponse.js";
import type { ChatTreeSetCurrentParams } from "./codex-app-server-generated/v2/ChatTreeSetCurrentParams.js";
import type { ChatTreeSetCurrentResponse } from "./codex-app-server-generated/v2/ChatTreeSetCurrentResponse.js";
import type { ThreadListParams } from "./codex-app-server-generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./codex-app-server-generated/v2/ThreadListResponse.js";
import type { ThreadForkParams } from "./codex-app-server-generated/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "./codex-app-server-generated/v2/ThreadForkResponse.js";
import type { ThreadGoal } from "./codex-app-server-generated/v2/ThreadGoal.js";
import type { ThreadGoalClearParams } from "./codex-app-server-generated/v2/ThreadGoalClearParams.js";
import type { ThreadGoalGetParams } from "./codex-app-server-generated/v2/ThreadGoalGetParams.js";
import type { ThreadGoalGetResponse } from "./codex-app-server-generated/v2/ThreadGoalGetResponse.js";
import type { ThreadGoalSetParams } from "./codex-app-server-generated/v2/ThreadGoalSetParams.js";
import type { ThreadReadParams } from "./codex-app-server-generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "./codex-app-server-generated/v2/ThreadReadResponse.js";
import type { ThreadResumeParams } from "./codex-app-server-generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./codex-app-server-generated/v2/ThreadResumeResponse.js";
import type { ThreadUnsubscribeParams } from "./codex-app-server-generated/v2/ThreadUnsubscribeParams.js";
import type { TurnInterruptParams } from "./codex-app-server-generated/v2/TurnInterruptParams.js";
import type { TurnSteerParams } from "./codex-app-server-generated/v2/TurnSteerParams.js";
import type { TurnStartResponse } from "./codex-app-server-generated/v2/TurnStartResponse.js";
import type { Turn } from "./codex-app-server-generated/v2/Turn.js";
import type { TurnItemsView } from "./codex-app-server-generated/v2/TurnItemsView.js";
import type { ThreadItem } from "./codex-app-server-generated/v2/ThreadItem.js";
import type { ResponseItem } from "./codex-app-server-generated/ResponseItem.js";
import type { SkillsListParams } from "./codex-app-server-generated/v2/SkillsListParams.js";
import type { SkillsListResponse } from "./codex-app-server-generated/v2/SkillsListResponse.js";
import type { JsonValue } from "./codex-app-server-generated/serde_json/JsonValue.js";
import { buildCodexTurnInput } from "./attachment-inputs.js";
import {
  type RecordedCodexTurnChanges,
  getRecordedCodexTurnChanges,
  recordCodexTurnChangesFromFileUpdate,
  recordCodexTurnChangesFromUnifiedDiff
} from "./engine-extensions/codex/turn-changes-store.js";
import { recordCodexHookRun } from "./engine-extensions/codex/hook-activity-store.js";
import {
  codexRawCustomToolCallId,
  codexRawResponseToolCallId,
  isCodexContextCompactionThreadItem,
  isCodexImageGenerationThreadItem,
  isCodexImageViewThreadItem,
  isCodexReasoningThreadItem,
  isCodexWebSearchThreadItem,
  mapCodexResponseItemStatus,
  summarizeCodexFunctionOutputBody,
  summarizeCodexImageGenerationInput,
  summarizeCodexImageGenerationOutput,
  summarizeCodexImageViewInput,
  summarizeCodexImageViewOutput,
  summarizeCodexRawReasoningItem,
  summarizeCodexReasoningThreadItem,
  summarizeCodexWebSearchAction
} from "./engine-extensions/codex/process-activity.js";
import { resolveHostToolDefinition } from "./host-tools.js";
import type {
  HostToolContentItem,
  HostToolRegistry,
  HostToolResult
} from "./host-tools.js";

type RuntimeListener = (event: CodexRuntimeEvent) => void;

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type JsonRpcPayload = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: string | number;
    message?: string;
    data?: Record<string, unknown>;
  };
};

type PendingApproval = {
  requestId: string;
  rawRequestId: string | number;
  sessionId: string;
  turnId: string;
  itemId: string;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  title: string;
  details?: string;
  availableDecisions?: unknown[];
  requestedPermissions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const codexHookActivityExtensionKey = "hook-activity";

type PendingApprovalResolution = {
  action: "approve" | "deny" | "defer";
};

type PendingInteraction = {
  requestId: string;
  rawRequestId: string | number;
  sessionId: string;
  turnId?: string;
  kind: "mcp_elicitation" | "tool_user_input";
  title: string;
};

type PendingInteractionResolution = {
  action: "accept" | "decline" | "cancel" | "submit" | "defer";
  response?: Record<string, unknown>;
};

type ProcessActivitySummaryState = {
  reasoning: Set<string>;
  webSearch: Set<string>;
};

type CodexSelectedConfig = {
  model?: string;
  modelProvider?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  cwd?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: string;
};

type ThreadTurnsListParams = {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
  itemsView?: TurnItemsView | null;
};

type ThreadTurnsListResponse = {
  data: Turn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

type CodexRevisionInput = number | string | bigint | null | undefined;

export type CodexOpenAiCompatibleAuth = {
  apiKey?: string;
  baseUrl?: string;
};

export type CodexAppServerRuntimePortOptions = {
  engineId?: string;
  commandPath?: string;
  commandArgs?: string[];
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  recordTurnChanges?: (input: RecordedCodexTurnChanges) => void;
  hostTools?: HostToolRegistry;
  now?: () => string;
};

const resolveDefaultCodexCommandPath = (): string => {
  const envCandidates = [
    process.env.AWB_CODEX_BIN,
    process.env.CODEX_BIN,
    process.env.CODEX_PATH
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const localCandidates = [
    "I:/codex-branch/codex.exe",
    "I:/codex-branch/codex/codex.exe"
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "codex.exe" : "codex";
};

const localRequestId = (value: string | number): string => String(value);

const chunkText = (value: string): string[] => {
  if (!value) {
    return [];
  }
  return value.split(/(?<=\n)/g).filter((chunk) => chunk.length > 0);
};

const mapFinishReason = (
  status: string | undefined
): "completed" | "interrupted" | "failed" => {
  switch (status) {
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
};

const mapSessionStatus = (
  status: Record<string, unknown> | undefined
): "idle" | "running" | "awaiting_approval" | "error" | "completed" => {
  if (!status || typeof status.type !== "string") {
    return "idle";
  }

  switch (status.type) {
    case "active":
      return "running";
    case "systemError":
      return "error";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
};

const stableStringify = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value, (_key, current: unknown) => {
      if (!isRecord(current)) {
        return current;
      }
      return Object.fromEntries(
        Object.entries(current).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
    });
  } catch {
    return undefined;
  }
};

const isSameApprovalDecision = (left: unknown, right: unknown): boolean => {
  if (typeof left === "string" && typeof right === "string") {
    return left.trim() === right.trim();
  }
  if (isRecord(left) && isRecord(right)) {
    return stableStringify(left) === stableStringify(right);
  }
  return false;
};

const resolveApprovalDecision = (
  approval: PendingApproval,
  action: "approve" | "deny" | "defer",
  requestedDecision?: unknown
): unknown => {
  const availableDecisions = approval.availableDecisions ?? [];
  const hasAvailableDecisions = availableDecisions.length > 0;
  const availableStrings = new Set(
    availableDecisions.filter(
      (decision): decision is string => typeof decision === "string"
    )
  );
  const availableObjects = availableDecisions.filter(isRecord);

  if (typeof requestedDecision === "string" && requestedDecision.trim().length > 0) {
    const decision = requestedDecision.trim();
    if (!hasAvailableDecisions || availableStrings.has(decision)) {
      return decision;
    }
  }
  if (isRecord(requestedDecision)) {
    const matchedDecision = availableObjects.find((decision) =>
      isSameApprovalDecision(decision, requestedDecision)
    );
    if (!hasAvailableDecisions || matchedDecision) {
      return matchedDecision ?? requestedDecision;
    }
  }

  if (action === "approve") {
    if (availableStrings.has("accept")) {
      return "accept";
    }
    if (availableStrings.has("acceptForSession")) {
      return "acceptForSession";
    }
    if (availableObjects.length > 0) {
      return availableObjects[0];
    }
    return "accept";
  }

  if (action === "deny") {
    if (availableStrings.has("decline")) {
      return "decline";
    }
    if (availableStrings.has("cancel")) {
      return "cancel";
    }
    return "decline";
  }

  return "cancel";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isThreadGoalStatus = (
  value: unknown
): value is ThreadGoal["status"] =>
  value === "active" ||
  value === "paused" ||
  value === "blocked" ||
  value === "usageLimited" ||
  value === "budgetLimited" ||
  value === "complete";

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const toJsonRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const toGrantedPermissionProfile = (
  value: Record<string, unknown> | undefined
): Record<string, unknown> => {
  if (!value) {
    return {};
  }
  const granted: Record<string, unknown> = {};
  if (isRecord(value.network)) {
    granted.network = value.network;
  }
  if (isRecord(value.fileSystem)) {
    granted.fileSystem = value.fileSystem;
  }
  return granted;
};

const stringifySummary = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const approvalDecisionLabel = (decision: unknown): string | undefined => {
  if (typeof decision === "string" && decision.trim().length > 0) {
    return decision.trim();
  }
  if (isRecord(decision)) {
    const [key] = Object.keys(decision);
    return key;
  }
  return undefined;
};

const normalizeCodexRevision = (
  value: CodexRevisionInput
): number | null | undefined => {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return Number.isFinite(value) ? value : undefined;
};

const resolveCodexConfigBaseUrl = (config: Config): string | undefined => {
  const activeProfileName = optionalString(config.profile);
  const activeProfile = activeProfileName
    ? config.profiles?.[activeProfileName]
    : undefined;
  const modelProviderName =
    optionalString(activeProfile?.model_provider) ?? optionalString(config.model_provider);
  const modelProviders = isRecord(config.model_providers)
    ? config.model_providers
    : undefined;
  const modelProvider = modelProviderName && isRecord(modelProviders?.[modelProviderName])
    ? modelProviders[modelProviderName]
    : undefined;
  return (
    optionalString(modelProvider?.base_url) ??
    optionalString(activeProfile?.chatgpt_base_url) ??
    optionalString(config.chatgpt_base_url) ??
    optionalString(config.openai_base_url) ??
    optionalString(config.base_url)
  );
};

const isTextThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "agentMessage" }> =>
  isRecord(item) && item.type === "agentMessage" && typeof item.id === "string";

const isFinalAnswerMessageItem = (
  item: Extract<ThreadItem, { type: "agentMessage" }>
): boolean => item.phase === "final_answer";

const isCommandExecutionThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "commandExecution" }> =>
  isRecord(item) && item.type === "commandExecution" && typeof item.id === "string";

const isFileChangeThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "fileChange" }> =>
  isRecord(item) && item.type === "fileChange" && typeof item.id === "string";

const isCollabAgentToolCallThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "collabAgentToolCall" }> =>
  isRecord(item) && item.type === "collabAgentToolCall" && typeof item.id === "string";

const isDynamicToolCallThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "dynamicToolCall" }> =>
  isRecord(item) && item.type === "dynamicToolCall" && typeof item.id === "string";

const isMcpToolCallThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "mcpToolCall" }> =>
  isRecord(item) && item.type === "mcpToolCall" && typeof item.id === "string";

const discoveredCodexSessionId = (threadId: string): string => `codex-thread:${threadId}`;

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

const mapCollabAgentStatus = (
  status: string | undefined
): "idle" | "running" | "awaiting_approval" | "error" | "completed" => {
  switch (status) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
    case "shutdown":
      return "completed";
    case "errored":
      return "error";
    case "interrupted":
    case "notFound":
    default:
      return "idle";
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
    return state.message?.trim()
      ? `${threadId}: ${state.status} — ${state.message.trim()}`
      : `${threadId}: ${state.status}`;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
};

const dynamicToolLabel = (
  item: Pick<Extract<ThreadItem, { type: "dynamicToolCall" }>, "tool"> & {
    namespace?: string | null;
  }
): string => (item.namespace ? `${item.namespace}.${item.tool}` : item.tool);

const summarizeDynamicToolInput = (
  item: Extract<ThreadItem, { type: "dynamicToolCall" }> & {
    namespace?: string | null;
  }
): string | undefined => {
  const label = dynamicToolLabel(item);
  if (item.arguments === undefined || item.arguments === null) {
    return label;
  }
  try {
    return `${label} ${JSON.stringify(item.arguments)}`;
  } catch {
    return label;
  }
};

const summarizeDynamicToolOutput = (
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>
): string | undefined => {
  if (!Array.isArray(item.contentItems) || item.contentItems.length === 0) {
    return undefined;
  }
  return item.contentItems
    .map((contentItem) => {
      if (contentItem.type === "inputText") {
        return contentItem.text;
      }
      if (contentItem.type === "inputImage") {
        return contentItem.imageUrl;
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join("\n");
};

const mcpToolLabel = (item: Extract<ThreadItem, { type: "mcpToolCall" }>): string => {
  const raw = item as Record<string, unknown>;
  const server = optionalString(raw.server) ?? "server";
  const tool = optionalString(raw.tool) ?? "tool";
  return `mcp.${server}.${tool}`;
};

const summarizeMcpToolInput = (
  item: Extract<ThreadItem, { type: "mcpToolCall" }>
): string | undefined => {
  const raw = item as Record<string, unknown>;
  const args = raw.arguments;
  const argumentSummary = stringifySummary(args);
  return argumentSummary ? `${mcpToolLabel(item)} ${argumentSummary}` : mcpToolLabel(item);
};

const summarizeMcpContent = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return stringifySummary(value);
  }
  const parts = value
    .map((entry) => {
      if (!isRecord(entry)) {
        return stringifySummary(entry);
      }
      if (typeof entry.text === "string") {
        return entry.text;
      }
      if (typeof entry.url === "string") {
        return entry.url;
      }
      return stringifySummary(entry);
    })
    .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const summarizeMcpToolOutput = (
  item: Extract<ThreadItem, { type: "mcpToolCall" }>
): string | undefined => {
  const raw = item as Record<string, unknown>;
  if (isRecord(raw.error) && typeof raw.error.message === "string") {
    return raw.error.message;
  }
  const result = isRecord(raw.result) ? raw.result : undefined;
  if (!result) {
    return undefined;
  }
  return (
    summarizeMcpContent(result.content) ??
    stringifySummary(result.structuredContent) ??
    stringifySummary(result)
  );
};

const readNonNegativeInteger = (
  record: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
};

const readPositiveInteger = (
  record: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = readNonNegativeInteger(record, key);
  return value && value > 0 ? value : undefined;
};

const numberFromRuntimeInteger = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

const codexHookRunStatuses = new Set<CodexHookRunRpc["status"]>([
  "running",
  "completed",
  "failed",
  "blocked",
  "stopped"
]);

const codexHookEntryKinds = new Set<CodexHookRunRpc["entries"][number]["kind"]>([
  "warning",
  "stop",
  "feedback",
  "context",
  "error"
]);

const normalizeCodexHookRun = (value: unknown): CodexHookRunRpc | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const eventName = typeof value.eventName === "string" ? value.eventName : undefined;
  const handlerType =
    typeof value.handlerType === "string" ? value.handlerType : undefined;
  const executionMode =
    typeof value.executionMode === "string" ? value.executionMode : undefined;
  const scope = typeof value.scope === "string" ? value.scope : undefined;
  const sourcePath =
    typeof value.sourcePath === "string" ? value.sourcePath : undefined;
  const source = typeof value.source === "string" ? value.source : "unknown";
  const status =
    typeof value.status === "string" &&
    codexHookRunStatuses.has(value.status as CodexHookRunRpc["status"])
      ? (value.status as CodexHookRunRpc["status"])
      : undefined;
  const displayOrder = numberFromRuntimeInteger(value.displayOrder);
  const startedAt = numberFromRuntimeInteger(value.startedAt);

  if (
    !id ||
    !eventName ||
    !handlerType ||
    !executionMode ||
    !scope ||
    !sourcePath ||
    !status ||
    displayOrder === undefined ||
    startedAt === undefined
  ) {
    return undefined;
  }

  const entries = Array.isArray(value.entries)
    ? value.entries
        .filter(isRecord)
        .map((entry) => {
          const kind =
            typeof entry.kind === "string" &&
            codexHookEntryKinds.has(
              entry.kind as CodexHookRunRpc["entries"][number]["kind"]
            )
              ? (entry.kind as CodexHookRunRpc["entries"][number]["kind"])
              : undefined;
          return kind
            ? {
                kind,
                text: typeof entry.text === "string" ? entry.text : ""
              }
            : undefined;
        })
        .filter((entry): entry is CodexHookRunRpc["entries"][number] =>
          Boolean(entry)
        )
    : [];

  return {
    id,
    eventName,
    handlerType,
    executionMode,
    scope,
    sourcePath,
    source,
    displayOrder,
    status,
    statusMessage:
      typeof value.statusMessage === "string" ? value.statusMessage : null,
    startedAt,
    completedAt: numberFromRuntimeInteger(value.completedAt) ?? null,
    durationMs: numberFromRuntimeInteger(value.durationMs) ?? null,
    entries
  };
};

const mapTokenUsageBreakdown = (
  value: unknown
):
  | {
      totalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    }
  | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    totalTokens: readNonNegativeInteger(value, "totalTokens") ?? 0,
    inputTokens: readNonNegativeInteger(value, "inputTokens") ?? 0,
    cachedInputTokens: readNonNegativeInteger(value, "cachedInputTokens") ?? 0,
    outputTokens: readNonNegativeInteger(value, "outputTokens") ?? 0,
    reasoningOutputTokens: readNonNegativeInteger(value, "reasoningOutputTokens") ?? 0
  };
};

const mapContextUsage = (value: unknown): ContextUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const total = mapTokenUsageBreakdown(value.total);
  if (!total) {
    return undefined;
  }
  const last = mapTokenUsageBreakdown(value.last);
  const contextWindow = readPositiveInteger(value, "modelContextWindow");
  const effectiveUsage = last ?? total;
  return {
    usedTokens: effectiveUsage.inputTokens,
    contextWindow,
    inputTokens: effectiveUsage.inputTokens,
    cachedInputTokens: effectiveUsage.cachedInputTokens,
    outputTokens: effectiveUsage.outputTokens,
    reasoningOutputTokens: effectiveUsage.reasoningOutputTokens,
    lastUsedTokens: last?.totalTokens
  };
};

export class CodexAppServerRuntimePort
  implements
    AdapterRuntimePort<CodexRuntimeRequest, CodexRuntimeResponse, CodexRuntimeEvent>
{
  private readonly engineId: string;
  private readonly commandPath: string;
  private readonly commandArgs: string[];
  private readonly resolveConversationIdBySessionId:
    | ((sessionId: string) => string | undefined)
    | undefined;
  private readonly hostTools: HostToolRegistry | undefined;
  private readonly now: () => string;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly pendingRpcById = new Map<string, PendingRpc>();
  private readonly threadIdBySessionId = new Map<string, string>();
  private readonly sessionIdByThreadId = new Map<string, string>();
  private readonly activeTurnIdByThreadId = new Map<string, string>();
  private readonly hookTurnIdByThreadAndRun = new Map<string, string>();
  private readonly rawCustomToolNameByTurnAndCall = new Map<string, string>();
  private readonly startedCodexToolItemIds = new Set<string>();
  private readonly warnedUnhandledItemLifecycle = new Set<string>();
  private readonly warnedUnhandledRawResponseItems = new Set<string>();
  private readonly pendingApprovalsById = new Map<string, PendingApproval>();
  private readonly pendingApprovalResolutionsById = new Map<
    string,
    PendingApprovalResolution
  >();
  private readonly pendingInteractionsById = new Map<string, PendingInteraction>();
  private readonly pendingInteractionResolutionsById = new Map<
    string,
    PendingInteractionResolution
  >();
  private readonly processActivitySummariesByTurn = new Map<
    string,
    ProcessActivitySummaryState
  >();
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private sequence = 0;
  private requestCounter = 0;
  private startConfig: AgentAdapterRuntimeConfig = {};
  private readonly recordTurnChanges: ((input: RecordedCodexTurnChanges) => void) | undefined;

  public constructor(options: CodexAppServerRuntimePortOptions = {}) {
    this.engineId = options.engineId ?? "codex";
    this.commandPath = options.commandPath ?? resolveDefaultCodexCommandPath();
    this.commandArgs = options.commandArgs ?? ["app-server"];
    this.resolveConversationIdBySessionId =
      options.resolveConversationIdBySessionId;
    this.recordTurnChanges = options.recordTurnChanges;
    this.hostTools = options.hostTools;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async start(config: AgentAdapterRuntimeConfig = {}): Promise<void> {
    if (this.process) {
      return;
    }

    this.startConfig = config;
    const child = spawn(this.commandPath, this.commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(config.env ?? {})
      }
    });

    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.consumeStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (!trimmed) {
        return;
      }
      this.emitEvent("runtime.error", {
        code: "CODEX_APP_SERVER_STDERR",
        message: trimmed,
        recoverable: true
      });
    });
    child.on("exit", (code, signal) => {
      this.process = undefined;
      this.emitEvent("runtime.error", {
        code: "CODEX_APP_SERVER_EXIT",
        message: `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        recoverable: false
      });
      for (const pending of this.pendingRpcById.values()) {
        pending.reject(new Error("codex app-server exited before responding."));
      }
      this.pendingRpcById.clear();
    });

    await this.rpc("initialize", {
      clientInfo: {
        name: "another-workbench",
        title: "Another Workbench",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.write({
      method: "initialized"
    });
  }

  public async stop(): Promise<void> {
    this.pendingRpcById.clear();
    this.pendingApprovalsById.clear();
    this.pendingApprovalResolutionsById.clear();
    this.threadIdBySessionId.clear();
    this.sessionIdByThreadId.clear();
    this.activeTurnIdByThreadId.clear();
    this.hookTurnIdByThreadAndRun.clear();
    this.rawCustomToolNameByTurnAndCall.clear();
    this.startedCodexToolItemIds.clear();
    this.warnedUnhandledItemLifecycle.clear();
    this.warnedUnhandledRawResponseItems.clear();

    const child = this.process;
    this.process = undefined;
    if (!child) {
      return;
    }
    child.kill();
  }

  public async request(payload: CodexRuntimeRequest): Promise<CodexRuntimeResponse> {
    switch (payload.method) {
      case "initialize":
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn/start":
        await this.handleTurnStart(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn/steer":
        await this.handleTurnSteer(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn/interrupt":
        await this.handleTurnInterrupt(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "approval/respond":
        await this.handleApprovalResponse(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "thread/goal/set":
        await this.handleThreadGoalSet(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "thread/goal/clear":
        await this.handleThreadGoalClear(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "interaction/respond":
        await this.handleInteractionResponse(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      default:
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
    }
  }

  public subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getThreadIdForSession(sessionId: string): string | undefined {
    return this.threadIdBySessionId.get(sessionId);
  }

  public attachThreadToSession(sessionId: string, threadId: string): void {
    const previousThreadId = this.threadIdBySessionId.get(sessionId);
    if (previousThreadId && previousThreadId !== threadId) {
      this.sessionIdByThreadId.delete(previousThreadId);
    }
    this.threadIdBySessionId.set(sessionId, threadId);
    this.sessionIdByThreadId.set(threadId, sessionId);
  }

  public async listThreads(
    params: Partial<ThreadListParams> = {}
  ): Promise<ThreadListResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("thread/list", {
      cursor: params.cursor ?? null,
      limit: params.limit ?? null,
      sortKey: params.sortKey ?? null,
      modelProviders: params.modelProviders ?? null,
      sourceKinds: params.sourceKinds ?? null,
      archived: params.archived ?? null,
      cwd: params.cwd ?? null,
      searchTerm: params.searchTerm ?? null
    })) as ThreadListResponse;
  }

  public async readThread(
    threadId: string,
    includeTurns = false
  ): Promise<Thread> {
    await this.start(this.startConfig);
    const result = (await this.rpc("thread/read", {
      threadId,
      includeTurns
    } satisfies ThreadReadParams)) as ThreadReadResponse;
    return result.thread;
  }

  public async refreshThreadGoalForSession(
    sessionId: string
  ): Promise<ThreadGoal | null> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return null;
    }
    await this.start(this.startConfig);
    const result = (await this.rpc("thread/goal/get", {
      threadId
    } satisfies ThreadGoalGetParams)) as ThreadGoalGetResponse;
    if (!result.goal) {
      this.emitEvent("thread.goal.cleared", {
        sessionId,
        threadId
      });
      return null;
    }
    const goal = this.mapThreadGoal(sessionId, result.goal, null);
    if (!goal) {
      return null;
    }
    this.emitEvent("thread.goal.updated", {
      sessionId,
      threadId,
      turnId: null,
      goal
    });
    return result.goal;
  }

  public async listThreadTurns(input: {
    threadId: string;
    cursor?: string | null;
    limit?: number | null;
    sortDirection?: "asc" | "desc" | null;
    itemsView?: TurnItemsView | null;
  }): Promise<ThreadTurnsListResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("thread/turns/list", {
      threadId: input.threadId,
      cursor: input.cursor ?? null,
      limit: input.limit ?? null,
      sortDirection: input.sortDirection ?? null,
      itemsView: input.itemsView ?? null
    } satisfies ThreadTurnsListParams)) as ThreadTurnsListResponse;
  }

  public async resumeThread(threadId: string): Promise<Thread> {
    await this.start(this.startConfig);
    const selected = this.resolveSelectedConfig();
    const result = (await this.rpc("thread/resume", {
      threadId,
      cwd: selected.cwd ?? this.startConfig.cwd ?? null,
      model: selected.model ?? null,
      modelProvider: selected.modelProvider ?? null,
      serviceTier: selected.serviceTier ?? null,
      approvalPolicy: selected.approvalPolicy ?? null,
      sandbox: selected.sandbox ?? null
    } satisfies ThreadResumeParams)) as ThreadResumeResponse;
    return result.thread;
  }

  public async forkThread(threadId: string): Promise<Thread> {
    await this.start(this.startConfig);
    const result = (await this.rpc("thread/fork", {
      threadId,
      threadSource: "user"
    } satisfies ThreadForkParams)) as ThreadForkResponse;
    return result.thread;
  }

  public async unsubscribeThread(threadId: string): Promise<void> {
    await this.start(this.startConfig);
    await this.rpc("thread/unsubscribe", {
      threadId
    } satisfies ThreadUnsubscribeParams);
  }

  public async interruptThread(
    threadId: string,
    options: { bestEffort?: boolean } = {}
  ): Promise<void> {
    try {
      await this.start(this.startConfig);
      await this.rpc("turn/interrupt", {
        threadId,
        turnId: ""
      } satisfies TurnInterruptParams);
    } catch (error) {
      if (!options.bestEffort) {
        throw error;
      }
      this.emitEvent("runtime.error", {
        code: "CODEX_TURN_INTERRUPT_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Codex turn interrupt failed during resume.",
        recoverable: true,
        details: {
          threadId
        }
      });
    }
  }

  public async readChatTree(threadId: string): Promise<ChatTreeReadResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("chatTree/read", {
      threadId
    } satisfies ChatTreeReadParams)) as ChatTreeReadResponse;
  }

  public async readChatTreeForSession(
    sessionId: string
  ): Promise<ChatTreeReadResponse | undefined> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return undefined;
    }
    return this.readChatTree(threadId);
  }

  public async setCurrentChatTreeNode(
    threadId: string,
    nodeId: string,
    expectedRevision?: CodexRevisionInput
  ): Promise<ChatTreeSetCurrentResponse> {
    await this.start(this.startConfig);
    const payload = {
      threadId,
      nodeId,
      expectedRevision: normalizeCodexRevision(expectedRevision) ?? null
    };
    return (await this.rpc(
      "chatTree/setCurrent",
      payload as unknown as ChatTreeSetCurrentParams
    )) as ChatTreeSetCurrentResponse;
  }

  public async setCurrentChatTreeNodeForSession(
    sessionId: string,
    nodeId: string,
    expectedRevision?: CodexRevisionInput
  ): Promise<boolean> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return false;
    }
    await this.setCurrentChatTreeNode(threadId, nodeId, expectedRevision);
    return true;
  }

  public async archiveThreadForSession(sessionId: string): Promise<boolean> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return false;
    }
    await this.archiveThread(threadId);
    return true;
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.start(this.startConfig);
    await this.rpc("thread/archive", {
      threadId
    } satisfies ThreadArchiveParams);
  }

  public async readAuthStatus(
    options: { includeToken?: boolean; refreshToken?: boolean } = {}
  ): Promise<GetAuthStatusResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("getAuthStatus", {
      includeToken: options.includeToken ?? false,
      refreshToken: options.refreshToken ?? false
    } satisfies GetAuthStatusParams)) as GetAuthStatusResponse;
  }

  public async readConfig(cwd?: string): Promise<ConfigReadResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("config/read", {
      includeLayers: false,
      cwd: cwd ?? null
    } satisfies ConfigReadParams)) as ConfigReadResponse;
  }

  public async readOpenAiCompatibleAuth(cwd?: string): Promise<CodexOpenAiCompatibleAuth> {
    const auth = await this.readAuthStatus({
      includeToken: true,
      refreshToken: true
    });
    if (!auth.authToken) {
      return {};
    }
    const config = await this.readConfig(cwd).catch(() => undefined);
    return {
      apiKey: auth.authToken,
      baseUrl: config ? resolveCodexConfigBaseUrl(config.config) : undefined
    };
  }

  public async readGitDiffToRemote(cwd: string): Promise<GitDiffToRemoteResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("gitDiffToRemote", {
      cwd
    } satisfies GitDiffToRemoteParams)) as GitDiffToRemoteResponse;
  }

  public async listSkills(
    params: Partial<SkillsListParams> = {}
  ): Promise<SkillsListResponse> {
    await this.start(this.startConfig);
    const payload: SkillsListParams = {
      forceReload: params.forceReload ?? false
    };
    if (params.cwds) {
      payload.cwds = params.cwds;
    }
    return (await this.rpc("skills/list", payload)) as SkillsListResponse;
  }

  public async reloadUserConfig(): Promise<void> {
    await this.start(this.startConfig);
    await this.rpc("config/batchWrite", {
      edits: [],
      reloadUserConfig: true
    } satisfies ConfigBatchWriteParams);
  }

  public async reloadMcpServers(): Promise<void> {
    await this.start(this.startConfig);
    await this.rpc("config/mcpServer/reload");
  }

  private async handleTurnStart(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    const content = String(payload.params.content ?? "");
    const attachments = Array.isArray(payload.params.attachments)
      ? (payload.params.attachments as Attachment[])
      : [];
    const cwd =
      typeof payload.params.cwd === "string" && payload.params.cwd.trim().length > 0
        ? payload.params.cwd
        : undefined;
    const threadId = await this.ensureThreadForSession(sessionId, cwd);
    const input = buildCodexTurnInput(content, attachments);

    const result = (await this.rpc("turn/start", {
      threadId,
      input
    })) as TurnStartResponse;

    if (result?.turn?.id) {
      this.setActiveTurnForThread(threadId, result.turn.id);
      this.emitEvent("turn.started", {
        sessionId,
        turnId: result.turn.id
      });
    }
  }

  private async handleTurnSteer(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    const expectedTurnId = String(payload.params.turnId ?? "");
    const content = String(payload.params.content ?? "");
    const attachments = Array.isArray(payload.params.attachments)
      ? (payload.params.attachments as Attachment[])
      : [];
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId || !expectedTurnId) {
      return;
    }
    const input = buildCodexTurnInput(content, attachments);
    await this.rpc("turn/steer", {
      threadId,
      input,
      expectedTurnId
    } satisfies TurnSteerParams);
  }

  private async handleTurnInterrupt(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    const threadId = this.threadIdBySessionId.get(sessionId);
    const turnId = String(payload.params.turnId ?? "");
    if (!threadId || !turnId) {
      return;
    }
    await this.rpc("turn/interrupt", {
      threadId,
      turnId
    } satisfies TurnInterruptParams);
  }

  private async handleThreadGoalSet(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    if (!sessionId) {
      return;
    }
    const cwd =
      typeof payload.params.cwd === "string" && payload.params.cwd.trim().length > 0
        ? payload.params.cwd
        : undefined;
    const objective =
      typeof payload.params.objective === "string"
        ? payload.params.objective
        : undefined;
    const hasObjective = objective !== undefined;
    const existingThreadId = this.threadIdBySessionId.get(sessionId);
    if (!hasObjective && !existingThreadId) {
      throw new Error(
        `Cannot update goal status before session is attached: ${sessionId}`
      );
    }
    const threadId = existingThreadId ?? (await this.ensureThreadForSession(sessionId, cwd));
    const params: ThreadGoalSetParams = {
      threadId
    };
    if (objective !== undefined) {
      params.objective = objective;
    }
    if (isThreadGoalStatus(payload.params.status)) {
      params.status = payload.params.status;
    }
    if (payload.params.tokenBudget === null) {
      params.tokenBudget = null;
    } else if (typeof payload.params.tokenBudget === "number") {
      params.tokenBudget = payload.params.tokenBudget;
    }
    await this.rpc("thread/goal/set", params);
  }

  private async handleThreadGoalClear(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    if (!sessionId) {
      return;
    }
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      throw new Error(`Cannot clear goal before session is attached: ${sessionId}`);
    }
    await this.rpc("thread/goal/clear", {
      threadId
    } satisfies ThreadGoalClearParams);
  }

  private async handleApprovalResponse(payload: CodexRuntimeRequest): Promise<void> {
    const requestId = String(payload.params.requestId ?? "");
    const approval = this.pendingApprovalsById.get(requestId);
    if (!approval) {
      return;
    }

    const action = String(payload.params.action ?? "defer") as
      | "approve"
      | "deny"
      | "defer";
    const responsePayload = isRecord(payload.params.payload)
      ? payload.params.payload
      : undefined;
    const requestedScope =
      payload.params.decision === "session" ||
      responsePayload?.scope === "session"
        ? "session"
        : "turn";

    const result =
      approval.method === "item/permissions/requestApproval"
        ? {
            permissions:
              action === "approve"
                ? toGrantedPermissionProfile(
                    toJsonRecord(responsePayload?.permissions) ??
                      approval.requestedPermissions
                  )
                : {},
            scope: action === "approve" ? requestedScope : "turn",
            ...(action === "approve" &&
            requestedScope === "turn" &&
            responsePayload?.strictAutoReview === true
              ? { strictAutoReview: true }
              : {})
          }
        : {
            decision: resolveApprovalDecision(
              approval,
              action,
              payload.params.decision ?? responsePayload?.decision
            )
          };

    this.write({
      id: approval.rawRequestId,
      result
    });
    this.pendingApprovalResolutionsById.set(requestId, { action });
  }

  private async handleInteractionResponse(payload: CodexRuntimeRequest): Promise<void> {
    const requestId = String(payload.params.requestId ?? "");
    const interaction = this.pendingInteractionsById.get(requestId);
    if (!interaction) {
      return;
    }

    const action = String(payload.params.action ?? "defer") as
      | "accept"
      | "decline"
      | "cancel"
      | "submit"
      | "defer";
    const responsePayload = isRecord(payload.params.response)
      ? payload.params.response
      : undefined;
    const resolvedAction =
      interaction.kind === "tool_user_input" ? "submit" : action;

    const result =
      interaction.kind === "tool_user_input"
        ? {
            answers: this.buildToolUserInputAnswers(payload.params.answers, responsePayload)
          }
        : this.buildMcpElicitationResponse(resolvedAction, payload.params, responsePayload);

    this.write({
      id: interaction.rawRequestId,
      result
    });
    this.pendingInteractionResolutionsById.set(requestId, {
      action: resolvedAction,
      response: isRecord(result) ? result : undefined
    });
  }

  private buildToolUserInputAnswers(
    answersInput: unknown,
    responsePayload: Record<string, unknown> | undefined
  ): Record<string, { answers: string[] }> {
    const source = isRecord(responsePayload?.answers)
      ? responsePayload.answers
      : isRecord(answersInput)
        ? answersInput
        : {};
    const answers: Record<string, { answers: string[] }> = {};
    for (const [questionId, value] of Object.entries(source)) {
      if (Array.isArray(value)) {
        answers[questionId] = {
          answers: value.filter((entry): entry is string => typeof entry === "string")
        };
        continue;
      }
      if (isRecord(value) && Array.isArray(value.answers)) {
        answers[questionId] = {
          answers: value.answers.filter((entry): entry is string => typeof entry === "string")
        };
      }
    }
    return answers;
  }

  private buildMcpElicitationResponse(
    action: "accept" | "decline" | "cancel" | "submit" | "defer",
    params: Record<string, unknown>,
    responsePayload: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const responseAction =
      action === "accept" || action === "submit"
        ? "accept"
        : action === "decline"
          ? "decline"
          : "cancel";
    const meta =
      responsePayload?._meta ??
      responsePayload?.meta ??
      params.meta ??
      null;
    return {
      action: responseAction,
      content:
        responseAction === "accept"
          ? responsePayload?.content ?? params.content ?? null
          : null,
      _meta: meta
    };
  }

  private hasPendingSessionRequest(sessionId: string): boolean {
    for (const approval of this.pendingApprovalsById.values()) {
      if (approval.sessionId === sessionId) {
        return true;
      }
    }
    for (const interaction of this.pendingInteractionsById.values()) {
      if (interaction.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  private async ensureThreadForSession(
    sessionId: string,
    cwd?: string
  ): Promise<string> {
    const existing = this.threadIdBySessionId.get(sessionId);
    if (existing) {
      return existing;
    }

    const selected = this.resolveSelectedConfig();
    const threadStartParams: Record<string, unknown> = {
      ephemeral: false,
      experimentalRawEvents: false
    };
    const dynamicTools = await this.hostTools?.listDefinitions({
      engineId: this.engineId,
      sessionId
    });
    if (dynamicTools && dynamicTools.length > 0) {
      threadStartParams.dynamicTools = dynamicTools.map((tool) => ({
        namespace: tool.namespace,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        deferLoading: tool.deferLoading ?? false
      }));
    }

    const resolvedCwd = cwd ?? selected.cwd ?? this.startConfig.cwd;
    if (resolvedCwd) {
      threadStartParams.cwd = resolvedCwd;
    }
    if (selected.model !== undefined) {
      threadStartParams.model = selected.model;
    }
    if (selected.modelProvider !== undefined) {
      threadStartParams.modelProvider = selected.modelProvider;
    }
    if (selected.serviceTier !== undefined) {
      threadStartParams.serviceTier = selected.serviceTier;
    }
    if (selected.approvalPolicy !== undefined) {
      threadStartParams.approvalPolicy = selected.approvalPolicy;
    }
    if (selected.sandbox !== undefined) {
      threadStartParams.sandbox = selected.sandbox;
    }

    const result = (await this.rpc("thread/start", threadStartParams)) as ThreadStartResponse;

    const threadId = result.thread.id;
    this.threadIdBySessionId.set(sessionId, threadId);
    this.sessionIdByThreadId.set(threadId, sessionId);
    return threadId;
  }

  private resolveSelectedConfig(): CodexSelectedConfig {
    const metadata = this.startConfig.metadata;
    if (!metadata || !isRecord(metadata.selectedConfig)) {
      return {};
    }
    return metadata.selectedConfig as CodexSelectedConfig;
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }

      let payload: JsonRpcPayload;
      try {
        payload = JSON.parse(line) as JsonRpcPayload;
      } catch (error) {
        this.emitEvent("runtime.error", {
          code: "CODEX_APP_SERVER_BAD_JSON",
          message: error instanceof Error ? error.message : "Failed to parse JSON line",
          recoverable: true,
          details: {
            rawLine: line
          }
        });
        continue;
      }

      if (typeof payload.method === "string" && payload.id !== undefined) {
        this.handleServerRequest(payload);
        continue;
      }

      if (typeof payload.method === "string") {
        this.handleNotification(payload.method, payload.params ?? {});
        continue;
      }

      if (payload.id !== undefined) {
        const requestId = localRequestId(payload.id);
        const pending = this.pendingRpcById.get(requestId);
        if (!pending) {
          continue;
        }
        this.pendingRpcById.delete(requestId);
        if (payload.error?.message) {
          pending.reject(new Error(payload.error.message));
        } else {
          pending.resolve(payload.result);
        }
      }
    }
  }

  private handleServerRequest(payload: JsonRpcPayload): void {
    const method = payload.method;
    const rawRequestId = payload.id;
    if (rawRequestId === undefined || !method) {
      return;
    }
    const params = isRecord(payload.params) ? payload.params : {};
    const threadId = String(params.threadId ?? "");
    const sessionId = this.sessionIdByThreadId.get(threadId) ?? threadId;
    const requestId = localRequestId(rawRequestId);

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const turnId = String(params.turnId ?? "");
        const itemId = String(params.itemId ?? requestId);
        const title =
          method === "item/fileChange/requestApproval"
            ? "Approve file change"
            : method === "item/permissions/requestApproval"
              ? "Approve additional permissions"
              : "Approve command execution";
        const details = [
          typeof params.reason === "string" ? params.reason : undefined,
          typeof params.command === "string" ? params.command : undefined,
          method === "item/permissions/requestApproval"
            ? stringifySummary({
                cwd: params.cwd,
                permissions: params.permissions
              })
            : undefined
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n\n");
        const availableDecisions = Array.isArray(params.availableDecisions)
          ? params.availableDecisions
          : undefined;
        const availableActions = availableDecisions
          ?.map(approvalDecisionLabel)
          .filter((value): value is string => Boolean(value));

        this.pendingApprovalsById.set(requestId, {
          requestId,
          rawRequestId,
          sessionId,
          turnId,
          itemId,
          method,
          title,
          details: details || undefined,
          availableDecisions,
          requestedPermissions: toJsonRecord(params.permissions),
          metadata: {
            protocolMethod: method,
            cwd: params.cwd,
            permissions: params.permissions,
            availableDecisions
          }
        });

        this.emitEvent("session.updated", {
          conversationId:
            this.resolveConversationIdBySessionId?.(sessionId) ?? sessionId,
          sessionId,
          status: "awaiting_approval"
        });
        this.emitEvent("approval.requested", {
          sessionId,
          turnId,
          requestId,
          approvalKind:
            method === "item/fileChange/requestApproval"
              ? "file_change"
              : method === "item/permissions/requestApproval"
                ? "custom"
                : "command",
          title,
          details: details || undefined,
          availableActions,
          metadata: {
            protocolMethod: method,
            cwd: params.cwd,
            permissions: params.permissions,
            availableDecisions
          },
          engineId: this.engineId
        });
        return;
      }
      case "item/tool/requestUserInput": {
        const turnId = String(params.turnId ?? "");
        const itemId = String(params.itemId ?? requestId);
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const details = questions
          .map((question) =>
            isRecord(question) && typeof question.question === "string"
              ? question.question
              : undefined
          )
          .filter((value): value is string => Boolean(value))
          .join("\n\n");

        this.pendingInteractionsById.set(requestId, {
          requestId,
          rawRequestId,
          sessionId,
          turnId,
          kind: "tool_user_input",
          title: "Input requested"
        });
        this.emitEvent("session.updated", {
          conversationId:
            this.resolveConversationIdBySessionId?.(sessionId) ?? sessionId,
          sessionId,
          status: "awaiting_approval"
        });
        this.emitEvent("interaction.requested", {
          sessionId,
          ...(turnId ? { turnId } : {}),
          requestId,
          interactionKind: "tool_user_input",
          title: "Input requested",
          details: details || undefined,
          payload: {
            protocolMethod: method,
            itemId,
            questions
          },
          engineId: this.engineId
        });
        return;
      }
      case "mcpServer/elicitation/request": {
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const serverName = optionalString(params.serverName);
        const title = serverName
          ? `MCP request from ${serverName}`
          : "MCP request";
        const details = typeof params.message === "string" ? params.message : undefined;

        this.pendingInteractionsById.set(requestId, {
          requestId,
          rawRequestId,
          sessionId,
          turnId,
          kind: "mcp_elicitation",
          title
        });
        this.emitEvent("session.updated", {
          conversationId:
            this.resolveConversationIdBySessionId?.(sessionId) ?? sessionId,
          sessionId,
          status: "awaiting_approval"
        });
        this.emitEvent("interaction.requested", {
          sessionId,
          ...(turnId ? { turnId } : {}),
          requestId,
          interactionKind: "mcp_elicitation",
          title,
          details,
          payload: {
            protocolMethod: method,
            ...params
          },
          engineId: this.engineId
        });
        return;
      }
      case "item/tool/call":
        void this.handleDynamicToolCallRequest(rawRequestId, params).catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : "Unknown dynamic tool call failure.";
          this.writeDynamicToolCallResponse(rawRequestId, {
            contentItems: [
              {
                type: "inputText",
                text: `Dynamic tool failed: ${message}`
              }
            ],
            success: false
          });
        });
        return;
      default:
        this.write({
          id: rawRequestId,
          error: {
            code: "UNSUPPORTED_SERVER_REQUEST",
            message: `Unsupported server request: ${method}`
          }
        });
        this.emitEvent("runtime.error", {
          sessionId,
          code: "UNSUPPORTED_SERVER_REQUEST",
          message: `Unsupported server request: ${method}`,
          recoverable: true
        });
    }
  }

  private async handleDynamicToolCallRequest(
    rawRequestId: string | number,
    params: Record<string, unknown>
  ): Promise<void> {
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId);
    const callId = optionalString(params.callId);
    const namespace = optionalString(params.namespace);
    const toolName = optionalString(params.tool);
    if (!threadId || !toolName) {
      this.writeDynamicToolCallResponse(rawRequestId, {
        contentItems: [
          {
            type: "inputText",
            text: "Dynamic tool failed: missing threadId or tool name."
          }
        ],
        success: false
      });
      return;
    }

    const sessionId = this.sessionIdByThreadId.get(threadId);
    if (!sessionId) {
      this.writeDynamicToolCallResponse(rawRequestId, {
        contentItems: [
          {
            type: "inputText",
            text: "Dynamic tool failed: calling session is unknown."
          }
        ],
        success: false
      });
      return;
    }

    const tool = this.hostTools?.resolve({
      namespace,
      name: toolName,
      context: {
        engineId: this.engineId,
        sessionId
      }
    });
    if (!tool) {
      this.writeDynamicToolCallResponse(rawRequestId, {
        contentItems: [
          {
            type: "inputText",
            text: `Unsupported dynamic tool: ${namespace ? `${namespace}.` : ""}${toolName}`
          }
        ],
        success: false
      });
      return;
    }

    const result = await tool.handle({
      definition: await resolveHostToolDefinition(tool, {
        engineId: this.engineId,
        sessionId
      }),
      arguments: (params.arguments ?? null) as JsonValue,
      context: {
        engineId: this.engineId,
        sessionId,
        providerSessionId: threadId,
        providerTurnId: turnId,
        providerToolCallId: callId
      }
    });
    this.writeDynamicToolCallResponse(rawRequestId, result);
  }

  private writeDynamicToolCallResponse(
    rawRequestId: string | number,
    result: HostToolResult
  ): void {
    this.write({
      id: rawRequestId,
      result: {
        contentItems: result.contentItems.map((contentItem) =>
          this.serializeHostToolContentItem(contentItem)
        ),
        success: result.success
      }
    });
  }

  private serializeHostToolContentItem(
    contentItem: HostToolContentItem
  ): Record<string, string> {
    if (contentItem.type === "inputImage") {
      return {
        type: "inputImage",
        imageUrl: contentItem.imageUrl
      };
    }
    return {
      type: "inputText",
      text: contentItem.text
    };
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/status/changed": {
        const threadId = String(params.threadId ?? "");
        const sessionId = this.sessionIdByThreadId.get(threadId);
        if (!sessionId) {
          return;
        }
        this.emitEvent("session.updated", {
          conversationId:
            this.resolveConversationIdBySessionId?.(sessionId) ?? sessionId,
          sessionId,
          status: mapSessionStatus(
            isRecord(params.status) ? params.status : undefined
          )
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const contextUsage = mapContextUsage(params.tokenUsage);
        if (!sessionId || !contextUsage) {
          return;
        }
        this.emitEvent("session.context.updated", {
          sessionId,
          contextUsage
        });
        return;
      }
      case "thread/goal/updated": {
        const threadId = typeof params.threadId === "string" ? params.threadId : "";
        const sessionId = this.resolveSessionIdFromThreadId(threadId);
        const goal = isRecord(params.goal)
          ? this.mapThreadGoal(sessionId, params.goal, params.turnId)
          : undefined;
        if (!sessionId || !goal) {
          return;
        }
        this.emitEvent("thread.goal.updated", {
          sessionId,
          threadId,
          turnId: typeof params.turnId === "string" ? params.turnId : null,
          goal
        });
        return;
      }
      case "thread/goal/cleared": {
        const threadId = typeof params.threadId === "string" ? params.threadId : "";
        const sessionId = this.resolveSessionIdFromThreadId(threadId);
        if (!sessionId || !threadId) {
          return;
        }
        this.emitEvent("thread.goal.cleared", {
          sessionId,
          threadId
        });
        return;
      }
      case "chatTree/updated": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const chatTree = isRecord(params.chatTree) ? params.chatTree : undefined;
        if (!sessionId || !chatTree) {
          return;
        }
        this.emitEvent("conversationGraph.updated", {
          sessionId,
          engineId: this.engineId,
          currentNodeId:
            typeof chatTree.currentNodeId === "string"
              ? chatTree.currentNodeId
              : undefined,
          revision:
            typeof chatTree.revision === "number" || typeof chatTree.revision === "string"
              ? chatTree.revision
              : typeof chatTree.revision === "bigint"
                ? chatTree.revision.toString()
                : undefined,
          visibleNodeIds: Array.isArray(chatTree.visibleNodeIds)
            ? chatTree.visibleNodeIds.filter(
                (value): value is string => typeof value === "string"
              )
            : [],
          visibleTurnIds: Array.isArray(chatTree.visibleTurnIds)
            ? chatTree.visibleTurnIds.filter(
                (value): value is string => typeof value === "string"
              )
            : []
        });
        return;
      }
      case "turn/started": {
        const threadId =
          typeof params.threadId === "string" ? params.threadId : undefined;
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turn = isRecord(params.turn) ? params.turn : undefined;
        if (!sessionId || !turn || typeof turn.id !== "string") {
          return;
        }
        if (threadId) {
          this.setActiveTurnForThread(threadId, turn.id);
        }
        this.emitEvent("turn.started", {
          sessionId,
          turnId: turn.id
        });
        return;
      }
      case "turn/completed": {
        const threadId =
          typeof params.threadId === "string" ? params.threadId : undefined;
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turn = isRecord(params.turn) ? params.turn : undefined;
        if (!sessionId || !turn || typeof turn.id !== "string") {
          return;
        }
        if (threadId) {
          this.clearActiveTurnForThread(threadId, turn.id);
        }
        this.emitEvent("turn.completed", {
          sessionId,
          turnId: turn.id,
          finishReason: mapFinishReason(
            typeof turn.status === "string" ? turn.status : undefined
          )
        });
        this.processActivitySummariesByTurn.delete(
          this.processActivityKey(sessionId, turn.id)
        );
        return;
      }
      case "turn/diff/updated": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const diff = typeof params.diff === "string" ? params.diff : undefined;
        if (!sessionId || !turnId || diff === undefined) {
          return;
        }
        recordCodexTurnChangesFromUnifiedDiff({
          sessionId,
          turnId,
          diff
        });
        const record = getRecordedCodexTurnChanges(sessionId, turnId);
        if (record) {
          this.recordTurnChanges?.(record);
        }
        return;
      }
      case "hook/started":
      case "hook/completed": {
        const threadId =
          typeof params.threadId === "string" ? params.threadId : undefined;
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const run = normalizeCodexHookRun(params.run);
        if (!sessionId || !run) {
          return;
        }
        const turnId = this.resolveHookActivityTurnId({
          threadId,
          rawTurnId: params.turnId,
          run
        });
        if (!turnId) {
          return;
        }
        recordCodexHookRun({
          sessionId,
          turnId,
          run
        });
        if (threadId) {
          if (method === "hook/started") {
            this.setHookTurnForThreadRun(threadId, run.id, turnId);
          } else {
            this.clearHookTurnForThreadRun(threadId, run.id);
          }
        }
        this.emitEvent("engineExtension.updated", {
          engineId: this.engineId,
          extensionKey: codexHookActivityExtensionKey,
          sessionId,
          turnId
        });
        return;
      }
      case "item/started":
      case "item/completed": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const item = isRecord(params.item) ? (params.item as ThreadItem) : undefined;
        if (!sessionId || !turnId || !item) {
          return;
        }
        this.handleItemLifecycle(method, sessionId, turnId, item);
        return;
      }
      case "rawResponseItem/completed": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const item = isRecord(params.item) ? (params.item as ResponseItem) : undefined;
        if (!sessionId || !turnId || !item) {
          return;
        }
        this.handleRawResponseItemCompleted(sessionId, turnId, item);
        return;
      }
      case "item/agentMessage/delta": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const messageId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!sessionId || !turnId || !messageId || !delta) {
          return;
        }
        this.emitEvent("message.delta", {
          sessionId,
          turnId,
          messageId,
          delta,
          engineId: this.engineId
        });
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const toolCallId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!sessionId || !turnId || !toolCallId || !delta) {
          return;
        }
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId,
          toolName: "reasoning",
          inputSummary:
            method === "item/reasoning/summaryTextDelta"
              ? "Reasoning summary"
              : "Reasoning",
          engineId: this.engineId
        });
        this.emitEvent("tool.delta", {
          sessionId,
          turnId,
          toolCallId,
          delta,
          engineId: this.engineId
        });
        return;
      }
      case "item/mcpToolCall/progress": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const toolCallId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.message === "string" ? params.message : "";
        if (!sessionId || !turnId || !toolCallId || !delta) {
          return;
        }
        this.emitEvent("tool.delta", {
          sessionId,
          turnId,
          toolCallId,
          delta,
          engineId: this.engineId
        });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const toolCallId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!sessionId || !turnId || !toolCallId || !delta) {
          return;
        }
        this.emitEvent("tool.delta", {
          sessionId,
          turnId,
          toolCallId,
          delta,
          engineId: this.engineId
        });
        this.emitEvent("terminal.output", {
          sessionId,
          turnId,
          terminalId: toolCallId,
          chunk: delta,
          engineId: this.engineId
        });
        return;
      }
      case "serverRequest/resolved":
        this.handleServerRequestResolved(params);
        return;
      case "error": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const error = isRecord(params.error) ? params.error : undefined;
        const codexErrorInfo = error?.codexErrorInfo;
        const additionalDetails = error?.additionalDetails;
        const willRetry = params.willRetry === true;
        this.emitEvent("runtime.error", {
          sessionId,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
          code:
            typeof codexErrorInfo === "string"
              ? codexErrorInfo
              : typeof params.code === "string"
                ? params.code
                : "CODEX_APP_SERVER_ERROR",
          message:
            typeof error?.message === "string"
              ? error.message
              : typeof params.message === "string"
                ? params.message
              : "Unknown codex app-server error",
          recoverable: willRetry,
          details:
            typeof additionalDetails === "string" && additionalDetails
              ? { additionalDetails }
              : undefined
        });
        return;
      }
      default:
        return;
    }
  }

  private handleServerRequestResolved(params: Record<string, unknown>): void {
    const rawRequestId = params.requestId;
    if (typeof rawRequestId !== "string" && typeof rawRequestId !== "number") {
      return;
    }
    const requestId = localRequestId(rawRequestId);
    if (!requestId) {
      return;
    }

    const approval = this.pendingApprovalsById.get(requestId);
    const resolution = this.pendingApprovalResolutionsById.get(requestId);
    if (approval) {
      this.pendingApprovalsById.delete(requestId);
      this.pendingApprovalResolutionsById.delete(requestId);

      this.emitEvent("approval.resolved", {
        sessionId: approval.sessionId,
        turnId: approval.turnId,
        requestId,
        action: resolution?.action ?? "defer",
        engineId: this.engineId
      });
      return;
    }

    const interaction = this.pendingInteractionsById.get(requestId);
    const interactionResolution = this.pendingInteractionResolutionsById.get(requestId);
    if (!interaction) {
      return;
    }

    this.pendingInteractionsById.delete(requestId);
    this.pendingInteractionResolutionsById.delete(requestId);

    this.emitEvent("interaction.resolved", {
      sessionId: interaction.sessionId,
      ...(interaction.turnId ? { turnId: interaction.turnId } : {}),
      requestId,
      action: interactionResolution?.action ?? "defer",
      response: interactionResolution?.response,
      engineId: this.engineId
    });

    if (!interaction.turnId && !this.hasPendingSessionRequest(interaction.sessionId)) {
      this.emitEvent("session.updated", {
        conversationId:
          this.resolveConversationIdBySessionId?.(interaction.sessionId) ??
          interaction.sessionId,
        sessionId: interaction.sessionId,
        status: "idle"
      });
    }
  }

  private handleItemLifecycle(
    method: "item/started" | "item/completed",
    sessionId: string,
    turnId: string,
    item: ThreadItem
  ): void {
    if (isTextThreadItem(item)) {
      this.emitEvent(method === "item/started" ? "message.started" : "message.completed", {
        sessionId,
        turnId,
        messageId: item.id,
        role: "assistant",
        phase: item.phase ?? undefined,
        ...(method === "item/completed" ? { finalText: item.text } : {}),
        ...(method === "item/completed" && isFinalAnswerMessageItem(item)
          ? { isFinalForTurn: true }
          : {}),
        engineId: this.engineId
      });
      return;
    }

    if (isCommandExecutionThreadItem(item)) {
      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "commandExecution",
          inputSummary: item.command,
          engineId: this.engineId
        });
        this.emitEvent("terminal.started", {
          sessionId,
          turnId,
          terminalId: item.id,
          toolCallId: item.id,
          engineId: this.engineId
        });
        return;
      }

      const completedStatus =
        item.status === "failed"
          ? "failed"
          : item.status === "declined"
            ? "cancelled"
            : "completed";
      this.emitEvent("terminal.completed", {
        sessionId,
        turnId,
        terminalId: item.id,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
        engineId: this.engineId
      });
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: completedStatus,
        outputSummary:
          typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : undefined,
          engineId: this.engineId
      });
      return;
    }

    if (isCodexReasoningThreadItem(item)) {
      if (method === "item/started") {
        return;
      }

      const outputSummary = summarizeCodexReasoningThreadItem(item);
      if (!outputSummary) {
        return;
      }
      this.emitEvent("tool.started", {
        sessionId,
        turnId,
        toolCallId: item.id,
        toolName: "reasoning",
        inputSummary: "Reasoning",
        engineId: this.engineId
      });
      this.rememberProcessActivitySummary(
        sessionId,
        turnId,
        "reasoning",
        outputSummary
      );
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: "completed",
        outputSummary,
        engineId: this.engineId
      });
      return;
    }

    if (isCodexWebSearchThreadItem(item)) {
      if (method === "item/started") {
        const inputSummary = summarizeCodexWebSearchAction(item.action, item.query);
        if (!inputSummary) {
          return;
        }
        this.rememberProcessActivitySummary(
          sessionId,
          turnId,
          "webSearch",
          inputSummary
        );
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "webSearch",
          inputSummary,
          engineId: this.engineId
        });
        return;
      }

      const outputSummary = summarizeCodexWebSearchAction(item.action, item.query);
      if (!outputSummary) {
        return;
      }
      this.rememberProcessActivitySummary(
        sessionId,
        turnId,
        "webSearch",
        outputSummary
      );
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: "completed",
        engineId: this.engineId
      });
      return;
    }

    if (isCodexContextCompactionThreadItem(item)) {
      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "contextCompaction",
          inputSummary: "compacting...",
          engineId: this.engineId
        });
        return;
      }

      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: "completed",
        outputSummary: "compaction finished",
        engineId: this.engineId
      });
      return;
    }

    if (isCodexImageViewThreadItem(item)) {
      const toolItemKey = this.codexToolItemKey(turnId, item.id);
      if (method === "item/started") {
        this.startedCodexToolItemIds.add(toolItemKey);
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "imageView",
          inputSummary: summarizeCodexImageViewInput(item),
          engineId: this.engineId
        });
        return;
      }

      if (!this.startedCodexToolItemIds.has(toolItemKey)) {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "imageView",
          inputSummary: summarizeCodexImageViewInput(item),
          engineId: this.engineId
        });
      }
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: "completed",
        outputSummary: summarizeCodexImageViewOutput(item),
        engineId: this.engineId
      });
      this.startedCodexToolItemIds.delete(toolItemKey);
      return;
    }

    if (isCodexImageGenerationThreadItem(item)) {
      const inputSummary = summarizeCodexImageGenerationInput(item);
      const toolItemKey = this.codexToolItemKey(turnId, item.id);
      if (method === "item/started") {
        this.startedCodexToolItemIds.add(toolItemKey);
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "imageGeneration",
          inputSummary,
          engineId: this.engineId
        });
        return;
      }

      if (!this.startedCodexToolItemIds.has(toolItemKey)) {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "imageGeneration",
          inputSummary,
          engineId: this.engineId
        });
      }
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: mapCodexResponseItemStatus(item.status),
        outputSummary: summarizeCodexImageGenerationOutput(item),
        engineId: this.engineId
      });
      this.startedCodexToolItemIds.delete(toolItemKey);
      return;
    }

    if (isMcpToolCallThreadItem(item)) {
      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: mcpToolLabel(item),
          inputSummary: summarizeMcpToolInput(item),
          engineId: this.engineId
        });
        return;
      }

      const raw = item as Record<string, unknown>;
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: raw.status === "failed" ? "failed" : "completed",
        outputSummary: summarizeMcpToolOutput(item),
        engineId: this.engineId
      });
      return;
    }

    if (isFileChangeThreadItem(item)) {
      recordCodexTurnChangesFromFileUpdate({
        sessionId,
        turnId,
        changes: item.changes
      });
      const record = getRecordedCodexTurnChanges(sessionId, turnId);
      if (record) {
        this.recordTurnChanges?.(record);
      }
      return;
    }

    if (isDynamicToolCallThreadItem(item)) {
      const dynamicItem = item as Extract<ThreadItem, { type: "dynamicToolCall" }> & {
        namespace?: string | null;
      };
      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: dynamicItem.id,
          toolName: dynamicToolLabel(dynamicItem),
          inputSummary: summarizeDynamicToolInput(dynamicItem),
          engineId: this.engineId
        });
        return;
      }

      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: dynamicItem.id,
        status:
          dynamicItem.status === "failed" || dynamicItem.success === false
            ? "failed"
            : "completed",
        outputSummary: summarizeDynamicToolOutput(dynamicItem),
        engineId: this.engineId
      });
      return;
    }

    if (isCollabAgentToolCallThreadItem(item)) {
      this.syncCollabAgentSessions(sessionId, turnId, item);

      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: mapCollabToolLabel(item.tool),
          inputSummary: summarizeCollabInput(item),
          engineId: this.engineId
        });
        return;
      }

      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: item.status === "failed" ? "failed" : "completed",
        outputSummary: summarizeCollabOutput(item),
        engineId: this.engineId
      });
      return;
    }

    this.warnUnhandledItemLifecycle(method, sessionId, turnId, item);
  }

  private handleRawResponseItemCompleted(
    sessionId: string,
    turnId: string,
    item: ResponseItem
  ): void {
    if (item.type === "reasoning") {
      const outputSummary = summarizeCodexRawReasoningItem(item);
      if (!outputSummary) {
        return;
      }
      if (
        this.hasProcessActivitySummary(sessionId, turnId, "reasoning", outputSummary)
      ) {
        return;
      }
      this.rememberProcessActivitySummary(
        sessionId,
        turnId,
        "reasoning",
        outputSummary
      );
      const toolCallId = codexRawResponseToolCallId(turnId, item, "reasoning");
      this.emitEvent("tool.started", {
        sessionId,
        turnId,
        toolCallId,
        toolName: "reasoning",
        inputSummary: "Reasoning summary",
        engineId: this.engineId
      });
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId,
        status: "completed",
        outputSummary,
        engineId: this.engineId
      });
      return;
    }

    if (item.type === "web_search_call") {
      const toolCallId = codexRawResponseToolCallId(turnId, item, "webSearch");
      const summary = summarizeCodexWebSearchAction(item.action);
      if (!summary) {
        return;
      }
      if (this.hasProcessActivitySummary(sessionId, turnId, "webSearch", summary)) {
        return;
      }
      this.rememberProcessActivitySummary(sessionId, turnId, "webSearch", summary);
      this.emitEvent("tool.started", {
        sessionId,
        turnId,
        toolCallId,
        toolName: "webSearch",
        inputSummary: summary,
        engineId: this.engineId
      });
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId,
        status: mapCodexResponseItemStatus(item.status),
        engineId: this.engineId
      });
      return;
    }

    if (item.type === "custom_tool_call") {
      const toolCallId = codexRawCustomToolCallId(turnId, item.call_id);
      this.rawCustomToolNameByTurnAndCall.set(
        this.rawCustomToolKey(turnId, item.call_id),
        item.name
      );
      this.emitEvent("tool.started", {
        sessionId,
        turnId,
        toolCallId,
        toolName: item.name,
        inputSummary: item.input.trim().length > 0 ? item.input : undefined,
        engineId: this.engineId
      });
      return;
    }

    if (item.type === "custom_tool_call_output") {
      const toolCallId = codexRawCustomToolCallId(turnId, item.call_id);
      const rawCustomToolKey = this.rawCustomToolKey(turnId, item.call_id);
      const toolName =
        this.rawCustomToolNameByTurnAndCall.get(rawCustomToolKey) ??
        optionalString(item.name);
      if (!this.rawCustomToolNameByTurnAndCall.has(rawCustomToolKey) && toolName) {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId,
          toolName,
          engineId: this.engineId
        });
      }
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId,
        status: mapCodexResponseItemStatus(undefined),
        outputSummary: summarizeCodexFunctionOutputBody(item.output),
        engineId: this.engineId
      });
      this.rawCustomToolNameByTurnAndCall.delete(rawCustomToolKey);
      return;
    }

    this.warnUnhandledRawResponseItem(sessionId, turnId, item);
  }

  private warnUnhandledItemLifecycle(
    method: "item/started" | "item/completed",
    sessionId: string,
    turnId: string,
    item: ThreadItem
  ): void {
    const itemType = isRecord(item) && typeof item.type === "string" ? item.type : "unknown";
    const key = `${method}:${itemType}`;
    if (this.warnedUnhandledItemLifecycle.has(key)) {
      return;
    }
    this.warnedUnhandledItemLifecycle.add(key);
    console.warn("[another-workbench] Ignored unsupported Codex ThreadItem.", {
      method,
      sessionId,
      turnId,
      itemType,
      itemId: optionalString((item as Record<string, unknown>).id)
    });
  }

  private warnUnhandledRawResponseItem(
    sessionId: string,
    turnId: string,
    item: ResponseItem
  ): void {
    const itemType = isRecord(item) && typeof item.type === "string" ? item.type : "unknown";
    if (this.warnedUnhandledRawResponseItems.has(itemType)) {
      return;
    }
    this.warnedUnhandledRawResponseItems.add(itemType);
    console.warn("[another-workbench] Ignored unsupported Codex raw ResponseItem.", {
      method: "rawResponseItem/completed",
      sessionId,
      turnId,
      itemType
    });
  }

  private processActivityKey(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  private codexToolItemKey(turnId: string, itemId: string): string {
    return `${turnId}\u0000${itemId}`;
  }

  private getProcessActivitySummaryState(
    sessionId: string,
    turnId: string
  ): ProcessActivitySummaryState {
    const key = this.processActivityKey(sessionId, turnId);
    const current = this.processActivitySummariesByTurn.get(key);
    if (current) {
      return current;
    }
    const next = {
      reasoning: new Set<string>(),
      webSearch: new Set<string>()
    };
    this.processActivitySummariesByTurn.set(key, next);
    return next;
  }

  private hasProcessActivitySummary(
    sessionId: string,
    turnId: string,
    kind: keyof ProcessActivitySummaryState,
    summary: string | undefined
  ): boolean {
    if (!summary) {
      return false;
    }
    return this.getProcessActivitySummaryState(sessionId, turnId)[kind].has(summary);
  }

  private rememberProcessActivitySummary(
    sessionId: string,
    turnId: string,
    kind: keyof ProcessActivitySummaryState,
    summary: string | undefined
  ): void {
    if (!summary) {
      return;
    }
    this.getProcessActivitySummaryState(sessionId, turnId)[kind].add(summary);
  }

  private syncCollabAgentSessions(
    parentSessionId: string,
    turnId: string,
    item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
  ): void {
    const conversationId = this.resolveConversationIdBySessionId?.(parentSessionId);
    if (!conversationId) {
      return;
    }

    for (const receiverThreadId of item.receiverThreadIds) {
      const childSessionId = discoveredCodexSessionId(receiverThreadId);
      this.attachThreadToSession(childSessionId, receiverThreadId);

      const childState = item.agentsStates[receiverThreadId];

      if (item.tool === "spawnAgent") {
        this.emitEvent("session.created", {
          conversationId,
          sessionId: childSessionId,
          engineId: this.engineId,
          status: mapCollabAgentStatus(childState?.status),
          relation: {
            relationId: `subagent:${parentSessionId}:${childSessionId}`,
            parentSessionId,
            childSessionId,
            relationType: "subagent",
            sourceTurnId: turnId,
            createdAt: this.now()
          }
        });
      }

      this.emitEvent("session.updated", {
        conversationId,
        sessionId: childSessionId,
        status: mapCollabAgentStatus(childState?.status),
        metadata: {
          providerKind: "codex-thread",
          providerSessionId: receiverThreadId
        }
      });
    }
  }

  private resolveSessionIdFromThreadId(rawThreadId: unknown): string | undefined {
    if (typeof rawThreadId !== "string") {
      return undefined;
    }
    return this.sessionIdByThreadId.get(rawThreadId);
  }

  private mapThreadGoal(
    sessionId: string | undefined,
    rawGoal: Record<string, unknown>,
    rawTurnId: unknown
  ): (ThreadGoal & { sessionId: string; turnId: string | null }) | undefined {
    if (!sessionId) {
      return undefined;
    }
    if (
      typeof rawGoal.threadId !== "string" ||
      typeof rawGoal.objective !== "string" ||
      !isThreadGoalStatus(rawGoal.status) ||
      typeof rawGoal.tokensUsed !== "number" ||
      typeof rawGoal.timeUsedSeconds !== "number" ||
      typeof rawGoal.createdAt !== "number" ||
      typeof rawGoal.updatedAt !== "number"
    ) {
      return undefined;
    }
    return {
      sessionId,
      threadId: rawGoal.threadId,
      objective: rawGoal.objective,
      status: rawGoal.status,
      tokenBudget: typeof rawGoal.tokenBudget === "number" ? rawGoal.tokenBudget : null,
      tokensUsed: rawGoal.tokensUsed,
      timeUsedSeconds: rawGoal.timeUsedSeconds,
      createdAt: rawGoal.createdAt,
      updatedAt: rawGoal.updatedAt,
      turnId: typeof rawTurnId === "string" ? rawTurnId : null
    };
  }

  private setActiveTurnForThread(threadId: string, turnId: string): void {
    this.activeTurnIdByThreadId.set(threadId, turnId);
  }

  private clearActiveTurnForThread(threadId: string, turnId: string): void {
    if (this.activeTurnIdByThreadId.get(threadId) === turnId) {
      this.activeTurnIdByThreadId.delete(threadId);
    }
  }

  private hookTurnKey(threadId: string, runId: string): string {
    return `${threadId}\u0000${runId}`;
  }

  private setHookTurnForThreadRun(
    threadId: string,
    runId: string,
    turnId: string
  ): void {
    this.hookTurnIdByThreadAndRun.set(this.hookTurnKey(threadId, runId), turnId);
  }

  private clearHookTurnForThreadRun(threadId: string, runId: string): void {
    this.hookTurnIdByThreadAndRun.delete(this.hookTurnKey(threadId, runId));
  }

  private rawCustomToolKey(turnId: string, callId: string): string {
    return `${turnId}\u0000${callId}`;
  }

  private resolveHookActivityTurnId(input: {
    threadId: string | undefined;
    rawTurnId: unknown;
    run: CodexHookRunRpc;
  }): string | undefined {
    if (typeof input.rawTurnId === "string" && input.rawTurnId.length > 0) {
      return input.rawTurnId;
    }
    const existingTurnId = input.threadId
      ? this.hookTurnIdByThreadAndRun.get(
          this.hookTurnKey(input.threadId, input.run.id)
        )
      : undefined;
    if (existingTurnId) {
      return existingTurnId;
    }
    const activeTurnId = input.threadId
      ? this.activeTurnIdByThreadId.get(input.threadId)
      : undefined;
    if (activeTurnId) {
      return activeTurnId;
    }
    console.warn(
      "[another-workbench] Ignoring Codex hook activity without an active turn.",
      {
        threadId: input.threadId,
        hookRunId: input.run.id,
        eventName: input.run.eventName,
        scope: input.run.scope
      }
    );
    return undefined;
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = String(++this.requestCounter);
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingRpcById.set(id, { resolve, reject });
    });
    this.write({
      id,
      method,
      ...(params === undefined ? {} : { params })
    });
    return result;
  }

  private write(payload: JsonRpcPayload): void {
    const child = this.process;
    if (!child) {
      throw new Error("codex app-server is not started.");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private emitEvent(method: EventType, params: Record<string, unknown>): void {
    this.sequence += 1;
    const event: CodexRuntimeEvent = {
      method,
      params,
      eventId: `codex-runtime-${this.sequence}`,
      cursor: String(this.sequence),
      occurredAt: this.now()
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const createCodexAppServerRuntimePort = (
  options: CodexAppServerRuntimePortOptions = {}
): CodexAppServerRuntimePort =>
  new CodexAppServerRuntimePort(options);
