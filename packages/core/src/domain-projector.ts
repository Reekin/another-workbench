import type { ContextUsage, RuntimeEvent } from "@another-workbench/shared";
import {
  appendLimitedStreamText,
  parseAgentParticipant,
  parseApprovalRequest,
  parseChatSession,
  parseConversation,
  parseMessageBlock,
  parseRuntimeInteraction,
  parseRuntimeEvent,
  parseToolCall,
  parseTurn
} from "@another-workbench/shared";
import type { RuntimeEventEnvelope } from "./event-bus.js";
import { DomainStore } from "./domain-store.js";

type ActorRef = {
  participantId?: string;
  engineId?: string;
};

type SessionRecordInput = {
  sessionId: string;
  conversationId?: string;
  engineId?: string;
  status?: "idle" | "running" | "awaiting_approval" | "error" | "completed";
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  lastTurnId?: string;
  metadata?: Record<string, unknown>;
  contextUsage?: ContextUsage;
};

type TurnRecordInput = {
  turnId: string;
  sessionId: string;
  status?: "started" | "streaming" | "completed";
  finishReason?: "completed" | "interrupted" | "failed";
  startedAt?: string;
  completedAt?: string;
  actor?: ActorRef;
  finalMessageId?: string;
  messageIds?: string[];
  toolCallIds?: string[];
  terminalIds?: string[];
  approvalRequestIds?: string[];
  interactionRequestIds?: string[];
};

export type DomainProjectorOptions = {
  store?: DomainStore;
  now?: () => string;
};

const unknownAgentId = "unknown-agent";
const unknownToolName = "unknown-tool";
const unknownApprovalTitle = "Approval request";

const runtimeErrorMessageId = (turnId: string): string => `runtime-error:${turnId}`;

const formatRuntimeErrorText = (
  event: Extract<RuntimeEvent, { type: "runtime.error" }>
): string =>
  event.code ? `Runtime error (${event.code}): ${event.message}` : `Runtime error: ${event.message}`;

const addUnique = (items: readonly string[], value: string): string[] =>
  items.includes(value) ? [...items] : [...items, value];

const actorFromEvent = (event: ActorRef): ActorRef | undefined =>
  event.participantId || event.engineId
    ? {
        participantId: event.participantId,
        engineId: event.engineId
      }
    : undefined;

const participantIdFor = (conversationId: string, engineId: string): string =>
  `participant-${conversationId}-${engineId}`;

const selectFinalAssistantMessageId = (
  store: DomainStore,
  messageIds: readonly string[]
): string | undefined => {
  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const candidateMessageId = messageIds[index];
    if (!candidateMessageId) {
      continue;
    }
    const assistantBlocks = store
      .listMessageBlocks({ messageId: candidateMessageId })
      .filter((block) => block.role === "assistant");
    const hasPhaseAwareBlocks = assistantBlocks.some((block) => block.phase);
    const hasFallbackEligibleBlocks = assistantBlocks.some(
      (block) => block.phase === "final_answer" || (!hasPhaseAwareBlocks && !block.phase)
    );
    if (hasFallbackEligibleBlocks) {
      return candidateMessageId;
    }
  }
  return undefined;
};

const withConversationSession = (
  conversation: ReturnType<DomainStore["getConversation"]>,
  input: {
    conversationId: string;
    sessionId: string;
    engineId: string;
    workspaceId?: string;
    timestamp: string;
  }
) =>
  parseConversation({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId ?? conversation?.workspaceId,
    participantEngineIds: addUnique(
      conversation?.participantEngineIds ?? [],
      input.engineId
    ),
    activeSessionId: input.sessionId,
    sessionIds: addUnique(conversation?.sessionIds ?? [], input.sessionId),
    createdAt: conversation?.createdAt ?? input.timestamp,
    updatedAt: input.timestamp,
    archivedAt: conversation?.archivedAt,
    metadata: conversation?.metadata
  });

export class DomainProjector {
  public readonly store: DomainStore;
  private readonly now: () => string;

  public constructor(options: DomainProjectorOptions = {}) {
    this.store = options.store ?? new DomainStore();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public apply(event: RuntimeEvent | unknown, occurredAt?: string): void {
    const parsedEvent = parseRuntimeEvent(event);
    this.project(parsedEvent, occurredAt);
  }

  public applyEnvelope(
    envelope: Pick<RuntimeEventEnvelope, "event" | "occurredAt">
  ): void {
    this.apply(envelope.event, envelope.occurredAt);
  }

  private project(event: RuntimeEvent, occurredAt?: string): void {
    const timestamp = occurredAt ?? this.now();

    switch (event.type) {
      case "conversation.updated": {
        const existing = this.store.getConversation(event.conversationId);
        const participantEngineIds = [
          ...(existing?.participantEngineIds ?? []),
          ...event.participantIds
            .map((participantId) => this.store.getParticipant(participantId)?.engineId)
            .filter((engineId): engineId is string => engineId !== undefined)
        ].reduce<string[]>((acc, value) => addUnique(acc, value), []);
        const sessionIds = this.store
          .listSessions({
            conversationId: event.conversationId,
            includeArchived: true
          })
          .map((session) => session.sessionId);

        this.store.upsertConversation({
          conversationId: event.conversationId,
          workspaceId: event.workspaceId ?? existing?.workspaceId,
          participantEngineIds,
          activeSessionId: event.activeSessionId ?? existing?.activeSessionId,
          sessionIds: sessionIds.length > 0 ? sessionIds : existing?.sessionIds ?? [],
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          archivedAt: existing?.archivedAt,
          metadata: existing?.metadata
        });
        return;
      }
      case "session.created": {
        const session = this.upsertSessionRecord({
          sessionId: event.sessionId,
          conversationId: event.conversationId,
          engineId: event.engineId,
          status: event.status,
          createdAt: this.store.getSession(event.sessionId)?.createdAt ?? timestamp,
          updatedAt: timestamp
        });
        this.store.upsertConversation(
          withConversationSession(this.store.getConversation(event.conversationId), {
            conversationId: event.conversationId,
            sessionId: event.sessionId,
            engineId: session.engineId,
            timestamp
          })
        );
        if (event.relation) {
          this.store.upsertSessionRelation(event.relation);
        }
        this.syncParticipantState(event.conversationId, session.engineId);
        return;
      }
      case "session.updated": {
        const existing = this.store.getSession(event.sessionId);
        const session = this.upsertSessionRecord({
          sessionId: event.sessionId,
          conversationId: event.conversationId,
          engineId: existing?.engineId ?? unknownAgentId,
          status: event.status,
          title: event.title ?? existing?.title,
          metadata: event.metadata ?? existing?.metadata,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          archivedAt: existing?.archivedAt,
          lastTurnId: existing?.lastTurnId
        });
        const existingConversation = this.store.getConversation(event.conversationId);
        this.store.upsertConversation({
          ...withConversationSession(existingConversation, {
            conversationId: event.conversationId,
            sessionId: event.sessionId,
            engineId: session.engineId,
            timestamp
          }),
          activeSessionId:
            event.status === "running" || event.status === "awaiting_approval"
              ? event.sessionId
              : existingConversation?.activeSessionId
        });
        this.syncParticipantState(event.conversationId, session.engineId);
        return;
      }
      case "session.context.updated": {
        const existing = this.store.getSession(event.sessionId);
        if (!existing) {
          return;
        }
        this.upsertSessionRecord({
          ...existing,
          contextUsage: event.contextUsage,
          updatedAt: timestamp
        });
        return;
      }
      case "session.archived": {
        const existing = this.store.getSession(event.sessionId);
        if (!existing) {
          return;
        }

        const session = this.upsertSessionRecord({
          ...existing,
          archivedAt: event.archivedAt,
          updatedAt: event.archivedAt
        });
        const conversation = this.store.getConversation(event.conversationId);
        if (conversation) {
          this.store.upsertConversation({
            ...conversation,
            activeSessionId: this.resolveNextActiveSessionId(
              event.conversationId,
              event.sessionId
            ),
            updatedAt: event.archivedAt
          });
        }
        this.syncParticipantState(event.conversationId, session.engineId);
        return;
      }
      case "session.disposed": {
        const existing = this.store.getSession(event.sessionId);
        const conversation = this.store.getConversation(event.conversationId);
        const engineId = existing?.engineId;

        this.store.deleteSessionCascade(event.sessionId);

        if (conversation) {
          this.store.upsertConversation({
            ...conversation,
            sessionIds: conversation.sessionIds.filter(
              (sessionId) => sessionId !== event.sessionId
            ),
            activeSessionId: this.resolveNextActiveSessionId(
              event.conversationId,
              event.sessionId
            ),
            updatedAt: event.disposedAt
          });
        }

        if (engineId) {
          this.syncParticipantState(event.conversationId, engineId);
        }
        return;
      }
      case "engineExtension.updated": {
        return;
      }
      case "participant.updated": {
        this.store.upsertParticipant(
          parseAgentParticipant({
            participantId: event.participantId,
            conversationId: event.conversationId,
            engineId: event.engineId,
            role: event.role,
            capabilities: event.capabilities,
            activeSessionIds: this.getActiveSessionIdsForParticipant(
              event.conversationId,
              event.engineId
            )
          })
        );
        const conversation = this.store.getConversation(event.conversationId);
        this.store.upsertConversation({
          conversationId: event.conversationId,
          workspaceId: conversation?.workspaceId,
          participantEngineIds: addUnique(
            conversation?.participantEngineIds ?? [],
            event.engineId
          ),
          activeSessionId: conversation?.activeSessionId,
          sessionIds:
            conversation?.sessionIds ??
            this.store
              .listSessions({
                conversationId: event.conversationId,
                includeArchived: true
              })
              .map((session) => session.sessionId),
          createdAt: conversation?.createdAt ?? timestamp,
          updatedAt: timestamp,
          archivedAt: conversation?.archivedAt,
          metadata: conversation?.metadata
        });
        return;
      }
      case "turn.started": {
        this.upsertTurnRecord({
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "started",
          startedAt: timestamp
        });
        this.setSessionStatus(event.sessionId, "running", timestamp, event.turnId);
        return;
      }
      case "turn.completed": {
        const existing = this.store.getTurn(event.turnId);
        const finalMessageId =
          existing?.finalMessageId ??
          selectFinalAssistantMessageId(this.store, existing?.messageIds ?? []);
        this.upsertTurnRecord({
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "completed",
          finishReason: event.finishReason,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: timestamp,
          actor: existing?.actor,
          finalMessageId,
          messageIds: existing?.messageIds,
          toolCallIds: existing?.toolCallIds,
          terminalIds: existing?.terminalIds,
          approvalRequestIds: existing?.approvalRequestIds,
          interactionRequestIds: existing?.interactionRequestIds
        });
        this.setSessionStatus(
          event.sessionId,
          event.finishReason === "failed" ? "error" : "idle",
          timestamp,
          event.turnId
        );
        return;
      }
      case "message.started": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const blockId = `${event.messageId}:md`;
        const existing = this.store.getMessageBlock(blockId);
        this.store.upsertMessageBlock(
          parseMessageBlock({
            blockId,
            messageId: event.messageId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            role: existing?.role ?? event.role,
            phase: event.phase ?? existing?.phase,
            kind: "markdown",
            text: existing?.text ?? "",
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "messageIds", event.messageId, timestamp);
        return;
      }
      case "message.delta": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const blockId = `${event.messageId}:md`;
        const existing = this.store.getMessageBlock(blockId);
        this.store.upsertMessageBlock(
          parseMessageBlock({
            blockId,
            messageId: event.messageId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            role: existing?.role ?? "assistant",
            phase: event.phase ?? existing?.phase,
            kind: "markdown",
            text: `${existing?.text ?? ""}${event.delta}`,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "messageIds", event.messageId, timestamp);
        return;
      }
      case "message.completed": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const blockId = `${event.messageId}:md`;
        const existing = this.store.getMessageBlock(blockId);
        this.store.upsertMessageBlock(
          parseMessageBlock({
            blockId,
            messageId: event.messageId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            role: existing?.role ?? "assistant",
            phase: event.phase ?? existing?.phase,
            kind: "markdown",
            text: event.finalText ?? existing?.text ?? "",
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "messageIds", event.messageId, timestamp);
        if (event.isFinalForTurn === true) {
          const turn = this.store.getTurn(event.turnId);
          if (turn) {
            this.upsertTurnRecord({
              turnId: turn.turnId,
              sessionId: turn.sessionId,
              status: turn.status,
              finishReason: turn.finishReason,
              startedAt: turn.startedAt,
              completedAt: turn.completedAt,
              actor: turn.actor,
              finalMessageId: event.messageId,
              messageIds: turn.messageIds,
              toolCallIds: turn.toolCallIds,
              terminalIds: turn.terminalIds,
              approvalRequestIds: turn.approvalRequestIds,
              interactionRequestIds: turn.interactionRequestIds
            });
          }
        }
        return;
      }
      case "tool.started": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        this.store.upsertToolCall(
          parseToolCall({
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolName: event.toolName,
            status: "running",
            inputSummary: event.inputSummary,
            actor,
            startedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "toolCallIds", event.toolCallId, timestamp);
        return;
      }
      case "tool.delta": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.store.getToolCall(event.toolCallId);
        this.store.upsertToolCall(
          parseToolCall({
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolName: existing?.toolName ?? unknownToolName,
            status: existing?.status ?? "running",
            inputSummary: existing?.inputSummary,
            outputSummary: appendLimitedStreamText(existing?.outputSummary, event.delta),
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "toolCallIds", event.toolCallId, timestamp);
        return;
      }
      case "tool.completed": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.store.getToolCall(event.toolCallId);
        this.store.upsertToolCall(
          parseToolCall({
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolName: existing?.toolName ?? unknownToolName,
            status: event.status,
            inputSummary: existing?.inputSummary,
            outputSummary:
              event.outputSummary != null
                ? appendLimitedStreamText(undefined, event.outputSummary)
                : existing?.outputSummary,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "toolCallIds", event.toolCallId, timestamp);
        return;
      }
      case "terminal.started": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        this.store.upsertTerminalStream({
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          status: "running",
          outputText: "",
          actor,
          startedAt: timestamp
        });
        this.appendTurnCollection(event.turnId, "terminalIds", event.terminalId, timestamp);
        return;
      }
      case "terminal.output": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.store.getTerminalStream(event.terminalId);
        this.store.upsertTerminalStream({
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: existing?.toolCallId,
          status: existing?.status ?? "running",
          outputText: appendLimitedStreamText(existing?.outputText, event.chunk),
          exitCode: existing?.exitCode,
          actor: existing?.actor ?? actor,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: existing?.completedAt
        });
        this.appendTurnCollection(event.turnId, "terminalIds", event.terminalId, timestamp);
        return;
      }
      case "terminal.completed": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.store.getTerminalStream(event.terminalId);
        const status =
          event.exitCode !== undefined && event.exitCode !== 0 ? "failed" : "completed";
        this.store.upsertTerminalStream({
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: existing?.toolCallId,
          status,
          outputText: existing?.outputText ?? "",
          exitCode: event.exitCode,
          actor: existing?.actor ?? actor,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: timestamp
        });
        this.appendTurnCollection(event.turnId, "terminalIds", event.terminalId, timestamp);
        return;
      }
      case "approval.requested": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        this.store.upsertApprovalRequest(
          parseApprovalRequest({
            requestId: event.requestId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            approvalKind: event.approvalKind,
            status: "pending",
            title: event.title,
            details: event.details,
            availableActions: event.availableActions,
            metadata: event.metadata,
            actor,
            requestedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "approvalRequestIds", event.requestId, timestamp);
        this.setSessionStatus(event.sessionId, "awaiting_approval", timestamp, event.turnId);
        return;
      }
      case "approval.resolved": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.store.getApprovalRequest(event.requestId);
        this.store.upsertApprovalRequest(
          parseApprovalRequest({
            requestId: event.requestId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            approvalKind: existing?.approvalKind ?? "custom",
            status:
              event.action === "approve"
                ? "approved"
                : event.action === "deny"
                  ? "denied"
                  : "deferred",
            title: existing?.title ?? unknownApprovalTitle,
            details: existing?.details,
            note: existing?.note,
            actor: existing?.actor ?? actor,
            requestedAt: existing?.requestedAt ?? timestamp,
            resolvedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "approvalRequestIds", event.requestId, timestamp);
        return;
      }
      case "interaction.requested": {
        const actor = actorFromEvent(event);
        if (event.turnId) {
          this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        }
        this.store.upsertRuntimeInteraction(
          parseRuntimeInteraction({
            requestId: event.requestId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            interactionKind: event.interactionKind,
            status: "pending",
            title: event.title,
            details: event.details,
            payload: event.payload,
            actor,
            requestedAt: timestamp
          })
        );
        if (event.turnId) {
          this.appendTurnCollection(event.turnId, "interactionRequestIds", event.requestId, timestamp);
        }
        this.setSessionStatus(event.sessionId, "awaiting_approval", timestamp, event.turnId);
        return;
      }
      case "interaction.resolved": {
        const actor = actorFromEvent(event);
        if (event.turnId) {
          this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        }
        const existing = this.store.getRuntimeInteraction(event.requestId);
        const status =
          event.action === "accept"
            ? "accepted"
            : event.action === "submit"
              ? "submitted"
              : event.action === "decline"
                ? "declined"
                : event.action === "cancel"
                  ? "cancelled"
                  : "deferred";
        this.store.upsertRuntimeInteraction(
          parseRuntimeInteraction({
            requestId: event.requestId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            interactionKind: existing?.interactionKind ?? "tool_user_input",
            status,
            title: existing?.title ?? "Input requested",
            details: existing?.details,
            payload: existing?.payload ?? {},
            response: event.response,
            actor: existing?.actor ?? actor,
            requestedAt: existing?.requestedAt ?? timestamp,
            resolvedAt: timestamp
          })
        );
        if (event.turnId) {
          this.appendTurnCollection(event.turnId, "interactionRequestIds", event.requestId, timestamp);
        }
        return;
      }
      case "runtime.error": {
        if (event.recoverable) {
          return;
        }
        if (event.sessionId && event.turnId) {
          const existingTurn = this.store.getTurn(event.turnId);
          const messageId =
            existingTurn?.messageIds.find((candidateMessageId) => {
              const block = this.store.getMessageBlock(`${candidateMessageId}:md`);
              return block !== undefined && (block.text ?? "").trim().length === 0;
            }) ?? runtimeErrorMessageId(event.turnId);
          const blockId = `${messageId}:md`;
          const existingBlock = this.store.getMessageBlock(blockId);

          this.store.upsertMessageBlock(
            parseMessageBlock({
              blockId,
              messageId,
              sessionId: event.sessionId,
              turnId: event.turnId,
              role: "system",
              kind: "markdown",
              text: formatRuntimeErrorText(event),
              actor: existingBlock?.actor,
              startedAt: existingBlock?.startedAt ?? timestamp,
              completedAt: timestamp
            })
          );
          this.appendTurnCollection(event.turnId, "messageIds", messageId, timestamp);
          this.upsertTurnRecord({
            turnId: event.turnId,
            sessionId: event.sessionId,
            status: "completed",
            finishReason: "failed",
            startedAt: existingTurn?.startedAt ?? timestamp,
            completedAt: timestamp,
            actor: existingTurn?.actor,
            finalMessageId: existingTurn?.finalMessageId,
            messageIds: existingTurn?.messageIds,
            toolCallIds: existingTurn?.toolCallIds,
            terminalIds: existingTurn?.terminalIds,
            approvalRequestIds: existingTurn?.approvalRequestIds,
            interactionRequestIds: existingTurn?.interactionRequestIds
          });
        }
        if (event.sessionId) {
          this.setSessionStatus(event.sessionId, "error", timestamp, event.turnId);
        }
        return;
      }
      default:
        return;
    }
  }

  private upsertSessionRecord(input: SessionRecordInput) {
    const existing = this.store.getSession(input.sessionId);
    const conversationId = input.conversationId ?? existing?.conversationId;
    if (!conversationId) {
      throw new Error(`Conversation id missing for session ${input.sessionId}.`);
    }

    const session = parseChatSession({
      sessionId: input.sessionId,
      conversationId,
      engineId: input.engineId ?? existing?.engineId ?? unknownAgentId,
      status: input.status ?? existing?.status ?? "idle",
      title: input.title ?? existing?.title,
      createdAt: input.createdAt ?? existing?.createdAt ?? this.now(),
      updatedAt: input.updatedAt ?? existing?.updatedAt ?? this.now(),
      archivedAt: input.archivedAt ?? existing?.archivedAt,
      lastTurnId: input.lastTurnId ?? existing?.lastTurnId,
      contextUsage: input.contextUsage ?? existing?.contextUsage,
      metadata: input.metadata ?? existing?.metadata
    });
    this.store.upsertSession(session);
    return session;
  }

  private upsertTurnRecord(input: TurnRecordInput) {
    const existing = this.store.getTurn(input.turnId);
    const turn = parseTurn({
      turnId: input.turnId,
      sessionId: input.sessionId,
      status: input.status ?? existing?.status ?? "streaming",
      finishReason: input.finishReason ?? existing?.finishReason,
      startedAt: input.startedAt ?? existing?.startedAt ?? this.now(),
      completedAt: input.completedAt ?? existing?.completedAt,
      actor: input.actor ?? existing?.actor,
      finalMessageId: input.finalMessageId ?? existing?.finalMessageId,
      messageIds: input.messageIds ?? existing?.messageIds ?? [],
      toolCallIds: input.toolCallIds ?? existing?.toolCallIds ?? [],
      terminalIds: input.terminalIds ?? existing?.terminalIds ?? [],
      approvalRequestIds: input.approvalRequestIds ?? existing?.approvalRequestIds ?? [],
      interactionRequestIds:
        input.interactionRequestIds ?? existing?.interactionRequestIds ?? []
    });
    this.store.upsertTurn(turn);
    return turn;
  }

  private setSessionStatus(
    sessionId: string,
    status: "idle" | "running" | "awaiting_approval" | "error" | "completed",
    timestamp: string,
    lastTurnId?: string
  ): void {
    const existing = this.store.getSession(sessionId);
    if (!existing) {
      return;
    }

    const updated = this.upsertSessionRecord({
      ...existing,
      status,
      updatedAt: timestamp,
      lastTurnId: lastTurnId ?? existing.lastTurnId
    });
    const conversation = this.store.getConversation(updated.conversationId);
    if (!conversation) {
      return;
    }

    this.store.upsertConversation(
      parseConversation({
        ...conversation,
        activeSessionId:
          status === "running" || status === "awaiting_approval"
            ? updated.sessionId
            : conversation.activeSessionId,
        updatedAt: timestamp
      })
    );
  }

  private markTurnStreaming(
    turnId: string,
    sessionId: string,
    timestamp: string,
    actor?: ActorRef
  ) {
    const existing = this.store.getTurn(turnId);
    const turn = this.upsertTurnRecord({
      turnId,
      sessionId,
      status: existing?.status === "completed" ? "completed" : "streaming",
      finishReason: existing?.finishReason,
      startedAt: existing?.startedAt ?? timestamp,
      completedAt: existing?.completedAt,
      actor: existing?.actor ?? actor,
      finalMessageId: existing?.finalMessageId,
      messageIds: existing?.messageIds,
      toolCallIds: existing?.toolCallIds,
      terminalIds: existing?.terminalIds,
      approvalRequestIds: existing?.approvalRequestIds,
      interactionRequestIds: existing?.interactionRequestIds
    });
    this.upsertSessionRecord({
      sessionId,
      lastTurnId: turnId,
      updatedAt: timestamp
    });
    return turn;
  }

  private appendTurnCollection(
    turnId: string,
    key:
      | "messageIds"
      | "toolCallIds"
      | "terminalIds"
      | "approvalRequestIds"
      | "interactionRequestIds",
    valueId: string,
    timestamp: string
  ): void {
    const turn = this.store.getTurn(turnId);
    if (!turn || (turn[key] ?? []).includes(valueId)) {
      return;
    }

    this.upsertTurnRecord({
      turnId,
      sessionId: turn.sessionId,
      status: turn.status,
      finishReason: turn.finishReason,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      actor: turn.actor,
      finalMessageId: turn.finalMessageId,
      messageIds: key === "messageIds" ? [...turn.messageIds, valueId] : turn.messageIds,
      toolCallIds: key === "toolCallIds" ? [...turn.toolCallIds, valueId] : turn.toolCallIds,
      terminalIds: key === "terminalIds" ? [...turn.terminalIds, valueId] : turn.terminalIds,
      approvalRequestIds:
        key === "approvalRequestIds"
          ? [...turn.approvalRequestIds, valueId]
          : turn.approvalRequestIds,
      interactionRequestIds:
        key === "interactionRequestIds"
          ? [...(turn.interactionRequestIds ?? []), valueId]
          : turn.interactionRequestIds
    });
    this.upsertSessionRecord({
      sessionId: turn.sessionId,
      lastTurnId: turnId,
      updatedAt: timestamp
    });
  }

  private syncParticipantState(
    conversationId: string,
    engineId: string
  ): void {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) {
      return;
    }

    const participantId = participantIdFor(conversationId, engineId);
    const existing = this.store.getParticipant(participantId);
    this.store.upsertParticipant(
      parseAgentParticipant({
        participantId,
        conversationId,
        engineId,
        role:
          existing?.role ??
          (conversation.participantEngineIds[0] === engineId ? "primary" : "secondary"),
        capabilities: existing?.capabilities ?? [],
        activeSessionIds: this.getActiveSessionIdsForParticipant(conversationId, engineId),
        metadata: existing?.metadata
      })
    );
  }

  private getActiveSessionIdsForParticipant(
    conversationId: string,
    engineId: string
  ): string[] {
    return this.store
      .listSessions({
        conversationId,
        engineId,
        includeArchived: true
      })
      .filter((session) => !session.archivedAt)
      .map((session) => session.sessionId);
  }

  private resolveNextActiveSessionId(
    conversationId: string,
    excludedSessionId?: string
  ): string | undefined {
    return this.store
      .listSessions({
        conversationId,
        includeArchived: false
      })
      .map((session) => session.sessionId)
      .find((sessionId) => sessionId !== excludedSessionId);
  }
}
