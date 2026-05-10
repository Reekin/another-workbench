import { z } from "zod";
import {
  zConversationId,
  zCursor,
  zEngineId,
  zEventId,
  zIsoDateTime,
  zJsonRecord,
  zMessageId,
  zParticipantId,
  zRequestId,
  zSessionId,
  zTerminalId,
  zToolCallId,
  zTurnId
} from "./common.js";
import {
  zContextUsageSchema,
  zMessagePhase,
  zSessionRelationSchema
} from "./domain.js";

export const eventTypes = [
  "conversation.updated",
  "session.created",
  "session.updated",
  "session.context.updated",
  "session.archived",
  "session.disposed",
  "turn.started",
  "turn.completed",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "terminal.started",
  "terminal.output",
  "terminal.completed",
  "approval.requested",
  "approval.resolved",
  "conversationGraph.updated",
  "participant.updated",
  "runtime.error"
] as const;

export type EventType = (typeof eventTypes)[number];

const zActorFields = {
  participantId: zParticipantId.optional(),
  engineId: zEngineId.optional()
} as const;

const zConversationUpdatedEvent = z.object({
  type: z.literal("conversation.updated"),
  conversationId: zConversationId,
  workspaceId: z.string().min(1).optional(),
  activeSessionId: zSessionId.optional(),
  participantIds: z.array(zParticipantId).default([])
});

const zSessionCreatedEvent = z.object({
  type: z.literal("session.created"),
  conversationId: zConversationId,
  sessionId: zSessionId,
  engineId: zEngineId,
  status: z.enum(["idle", "running", "awaiting_approval", "error", "completed"]),
  relation: zSessionRelationSchema.optional()
});

const zSessionUpdatedEvent = z.object({
  type: z.literal("session.updated"),
  conversationId: zConversationId,
  sessionId: zSessionId,
  status: z.enum(["idle", "running", "awaiting_approval", "error", "completed"]),
  title: z.string().min(1).optional(),
  metadata: zJsonRecord.optional()
});

const zSessionContextUpdatedEvent = z.object({
  type: z.literal("session.context.updated"),
  sessionId: zSessionId,
  contextUsage: zContextUsageSchema
});

const zSessionArchivedEvent = z.object({
  type: z.literal("session.archived"),
  conversationId: zConversationId,
  sessionId: zSessionId,
  archivedAt: zIsoDateTime
});

const zSessionDisposedEvent = z.object({
  type: z.literal("session.disposed"),
  conversationId: zConversationId,
  sessionId: zSessionId,
  disposedAt: zIsoDateTime
});

const zTurnStartedEvent = z.object({
  type: z.literal("turn.started"),
  sessionId: zSessionId,
  turnId: zTurnId
});

const zTurnCompletedEvent = z.object({
  type: z.literal("turn.completed"),
  sessionId: zSessionId,
  turnId: zTurnId,
  finishReason: z.enum(["completed", "interrupted", "failed"])
});

const zMessageStartedEvent = z
  .object({
    type: z.literal("message.started"),
    sessionId: zSessionId,
    turnId: zTurnId,
    messageId: zMessageId,
    role: z.enum(["assistant", "user", "system"]),
    phase: zMessagePhase.optional(),
    ...zActorFields
  });

const zMessageDeltaEvent = z
  .object({
    type: z.literal("message.delta"),
    sessionId: zSessionId,
    turnId: zTurnId,
    messageId: zMessageId,
    delta: z.string(),
    phase: zMessagePhase.optional(),
    ...zActorFields
  });

const zMessageCompletedEvent = z
  .object({
    type: z.literal("message.completed"),
    sessionId: zSessionId,
    turnId: zTurnId,
    messageId: zMessageId,
    finalText: z.string().optional(),
    isFinalForTurn: z.boolean().optional(),
    phase: zMessagePhase.optional(),
    ...zActorFields
  });

const zToolStartedEvent = z
  .object({
    type: z.literal("tool.started"),
    sessionId: zSessionId,
    turnId: zTurnId,
    toolCallId: zToolCallId,
    toolName: z.string().min(1),
    inputSummary: z.string().optional(),
    ...zActorFields
  });

const zToolDeltaEvent = z
  .object({
    type: z.literal("tool.delta"),
    sessionId: zSessionId,
    turnId: zTurnId,
    toolCallId: zToolCallId,
    delta: z.string(),
    ...zActorFields
  });

const zToolCompletedEvent = z
  .object({
    type: z.literal("tool.completed"),
    sessionId: zSessionId,
    turnId: zTurnId,
    toolCallId: zToolCallId,
    status: z.enum(["completed", "failed", "cancelled"]),
    outputSummary: z.string().optional(),
    ...zActorFields
  });

const zTerminalStartedEvent = z
  .object({
    type: z.literal("terminal.started"),
    sessionId: zSessionId,
    turnId: zTurnId,
    terminalId: zTerminalId,
    toolCallId: zToolCallId.optional(),
    ...zActorFields
  });

const zTerminalOutputEvent = z
  .object({
    type: z.literal("terminal.output"),
    sessionId: zSessionId,
    turnId: zTurnId,
    terminalId: zTerminalId,
    chunk: z.string(),
    ...zActorFields
  });

const zTerminalCompletedEvent = z
  .object({
    type: z.literal("terminal.completed"),
    sessionId: zSessionId,
    turnId: zTurnId,
    terminalId: zTerminalId,
    exitCode: z.number().int().optional(),
    ...zActorFields
  });

const zApprovalRequestedEvent = z
  .object({
    type: z.literal("approval.requested"),
    sessionId: zSessionId,
    turnId: zTurnId,
    requestId: zRequestId,
    approvalKind: z.enum(["command", "file_change", "tool", "custom"]),
    title: z.string().min(1),
    details: z.string().optional(),
    ...zActorFields
  });

const zApprovalResolvedEvent = z
  .object({
    type: z.literal("approval.resolved"),
    sessionId: zSessionId,
    turnId: zTurnId,
    requestId: zRequestId,
    action: z.enum(["approve", "deny", "defer"]),
    ...zActorFields
  });

const zParticipantUpdatedEvent = z.object({
  type: z.literal("participant.updated"),
  conversationId: zConversationId,
  participantId: zParticipantId,
  engineId: zEngineId,
  role: z.enum(["primary", "secondary", "observer"]),
  capabilities: z.array(z.string().min(1)).default([])
});

const zConversationGraphUpdatedEvent = z.object({
  type: z.literal("conversationGraph.updated"),
  sessionId: zSessionId,
  engineId: zEngineId.optional(),
  currentNodeId: z.string().min(1).optional(),
  revision: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
  visibleNodeIds: z.array(z.string().min(1)).default([]),
  visibleTurnIds: z.array(zTurnId).default([])
});

const zRuntimeErrorEvent = z.object({
  type: z.literal("runtime.error"),
  sessionId: zSessionId.optional(),
  turnId: zTurnId.optional(),
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean().default(false),
  details: zJsonRecord.optional()
});

const actorScopedEventTypes = new Set<EventType>([
  "tool.started",
  "tool.delta",
  "tool.completed",
  "terminal.started",
  "terminal.output",
  "terminal.completed",
  "approval.requested",
  "approval.resolved"
]);

export const zEventSchema = z
  .discriminatedUnion("type", [
    zConversationUpdatedEvent,
    zSessionCreatedEvent,
    zSessionUpdatedEvent,
    zSessionContextUpdatedEvent,
    zSessionArchivedEvent,
    zSessionDisposedEvent,
    zTurnStartedEvent,
    zTurnCompletedEvent,
    zMessageStartedEvent,
    zMessageDeltaEvent,
    zMessageCompletedEvent,
    zToolStartedEvent,
    zToolDeltaEvent,
    zToolCompletedEvent,
    zTerminalStartedEvent,
    zTerminalOutputEvent,
    zTerminalCompletedEvent,
    zApprovalRequestedEvent,
    zApprovalResolvedEvent,
    zConversationGraphUpdatedEvent,
    zParticipantUpdatedEvent,
    zRuntimeErrorEvent
  ])
  .superRefine((event, ctx) => {
    if (
      actorScopedEventTypes.has(event.type) &&
      !("participantId" in event && event.participantId) &&
      !("engineId" in event && event.engineId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Actor-scoped events require participantId or engineId."
      });
    }
  });

export const zEventEnvelopeSchema = z.object({
  eventId: zEventId,
  cursor: zCursor.optional(),
  occurredAt: zIsoDateTime.optional(),
  event: zEventSchema
});

export type RuntimeEvent = z.infer<typeof zEventSchema>;
export type EventEnvelope = z.infer<typeof zEventEnvelopeSchema>;

export const parseRuntimeEvent = (value: unknown): RuntimeEvent =>
  zEventSchema.parse(value);

export const parseEventEnvelope = (value: unknown): EventEnvelope =>
  zEventEnvelopeSchema.parse(value);

export const safeParseRuntimeEvent = (value: unknown) =>
  zEventSchema.safeParse(value);

export const safeParseEventEnvelope = (value: unknown) =>
  zEventEnvelopeSchema.safeParse(value);

export const isEventType = (value: string): value is EventType =>
  (eventTypes as readonly string[]).includes(value);
