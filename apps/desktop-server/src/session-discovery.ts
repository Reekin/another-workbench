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

const isCommandExecutionItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "commandExecution" }> =>
  item.type === "commandExecution";

const isAgentMessageItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "agentMessage" }> =>
  item.type === "agentMessage";

const isUserMessageItem = (
  item: ThreadItem
): item is Extract<ThreadItem, { type: "userMessage" }> =>
  item.type === "userMessage";

const hydratedItemId = (sessionId: string, itemId: string): string =>
  `hydrated:${sessionId}:${itemId}`;

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
  agentId: string;
  providerKind: string;
  providerSessionId: string;
  title: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
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

export type HydratedSessionSnapshot = {
  workspaceId: string;
  conversation: Conversation;
  session: ChatSession;
  turns: Turn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  sessionRelations: SessionRelation[];
  runtimeBinding?: {
    providerKind: string;
    providerSessionId: string;
  };
};

export type SessionDiscoveryProvider = {
  readonly agentId: string;
  discoverWorkspace: (workspace: WorkspaceRecord) => Promise<DiscoveredWorkspaceResult>;
  hydrateSession: (
    entry: SessionIndexEntry,
    input?: {
      isCancelled?: () => boolean;
    }
  ) => Promise<HydratedSessionSnapshot | undefined>;
};

export class CodexSessionDiscoveryProvider implements SessionDiscoveryProvider {
  public readonly agentId = codexAgentId;

  private readonly codexRuntimePort: CodexAppServerRuntimePort;

  public constructor(options: { codexRuntimePort: CodexAppServerRuntimePort }) {
    this.codexRuntimePort = options.codexRuntimePort;
  }

  public async discoverWorkspace(
    workspace: WorkspaceRecord
  ): Promise<DiscoveredWorkspaceResult> {
    const threads = (await this.listAllThreads()).filter((thread) =>
      isPathInsideWorkspace(thread.cwd, workspace.absolutePath)
    );
    const sessions = threads.map((thread) =>
      this.toDiscoveredSessionRecord(thread)
    );
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
      participantAgentIds: [codexAgentId],
      activeSessionId: entry.sessionId,
      sessionIds: [entry.sessionId],
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt)
    });
    const session = parseChatSession({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      agentId: codexAgentId,
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

    const turns: Turn[] = [];
    const messageBlocks: MessageBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const terminalStreams: TerminalStream[] = [];

    for (const [turnIndex, turn] of thread.turns.entries()) {
      if (input.isCancelled?.()) {
        return undefined;
      }
      const startedAt = buildDeterministicTurnTimestamp(thread, turnIndex);
      const completedAt =
        turn.status === "inProgress"
          ? undefined
          : buildDeterministicTurnTimestamp(thread, turnIndex, turn.items.length + 1);
      const messageIds: string[] = [];
      const toolCallIds: string[] = [];
      const terminalIds: string[] = [];

      for (const [itemIndex, item] of turn.items.entries()) {
        if (input.isCancelled?.()) {
          return undefined;
        }
        const itemStartedAt = buildDeterministicTurnTimestamp(thread, turnIndex, itemIndex);
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
          messageBlocks.push(
            parseMessageBlock({
              blockId: `${itemEntityId}:md`,
              messageId: itemEntityId,
              sessionId: entry.sessionId,
              turnId: turn.id,
              role: "assistant",
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
              outputSummary: item.aggregatedOutput ?? undefined,
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
              outputText: item.aggregatedOutput ?? "",
              exitCode: item.exitCode ?? undefined,
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

      turns.push(
        parseTurn({
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
        })
      );
    }

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

  private toDiscoveredSessionRecord(thread: Thread): DiscoveredSessionRecord {
    return {
      sessionId: discoveredCodexSessionId(thread.id),
      agentId: codexAgentId,
      providerKind: codexProviderKind,
      providerSessionId: thread.id,
      title: titleForThread(thread),
      summaryText: summarizeThread(thread),
      createdAt: isoFromUnixSeconds(thread.createdAt),
      updatedAt: isoFromUnixSeconds(thread.updatedAt),
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
  private readonly providersByAgentId: Map<string, SessionDiscoveryProvider>;

  public constructor(options: {
    workspaceRegistry: WorkspaceRegistryService;
    sessionIndexStore: SessionIndexStore;
    runtimeService: WorkbenchRuntimeService;
    providers?: SessionDiscoveryProvider[];
  }) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.runtimeService = options.runtimeService;
    this.providersByAgentId = new Map(
      (options.providers ?? []).map((provider) => [provider.agentId, provider] as const)
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
      for (const provider of this.providersByAgentId.values()) {
        const discovered = await provider.discoverWorkspace(workspace);
        const conversationIdBySessionId = buildConversationMap(
          discovered.sessions,
          discovered.relations
        );
        const entries: UpsertSessionIndexInput[] = discovered.sessions.map((session) => ({
          workspaceId: workspace.workspaceId,
          session: {
            sessionId: session.sessionId,
            conversationId:
              conversationIdBySessionId.get(session.sessionId) ??
              discoveredConversationId(session.sessionId),
            agentId: session.agentId,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            archivedAt: session.archivedAt,
            metadata: session.metadata
          },
          providerKind: session.providerKind,
          providerSessionId: session.providerSessionId,
          summaryText: session.summaryText,
          source: "reconciled"
        }));
        const relations: UpsertSessionRelationInput[] = discovered.relations.map((relation) => ({
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
              entry.agentId === provider.agentId &&
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

  public async ensureSessionLoaded(
    sessionId: string,
    input: {
      isCancelled?: () => boolean;
    } = {}
  ): Promise<boolean> {
    const loaded = this.runtimeService
      .listSessions({ includeArchived: true })
      .some((session) => session.sessionId === sessionId);
    if (loaded) {
      return true;
    }

    await this.sessionIndexStore.ready();
    const entry = this.sessionIndexStore.getEntry(sessionId);
    if (!entry) {
      return false;
    }
    const provider = this.providersByAgentId.get(entry.agentId);
    if (!provider) {
      return false;
    }
    const hydrated = await provider.hydrateSession(entry, input);
    if (!hydrated) {
      return false;
    }
    this.runtimeService.hydrateDiscoveredSession(hydrated, {
      relatedIndexRelations: this.sessionIndexStore
        .listRelations(entry.workspaceId)
        .filter(
          (relation) =>
            relation.parentSessionId === sessionId || relation.childSessionId === sessionId
        )
    });
    return true;
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
