import { z } from "zod";
import {
  zActorRef,
  zConversationId,
  zEngineId,
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

export const zSessionStatus = z.enum([
  "idle",
  "running",
  "awaiting_approval",
  "error",
  "completed"
]);

export const zTurnStatus = z.enum(["started", "streaming", "completed"]);

export const zTurnFinishReason = z.enum([
  "completed",
  "interrupted",
  "failed"
]);

export const zMessageRole = z.enum(["assistant", "user", "system"]);

export const zMessageBlockKind = z.enum([
  "markdown",
  "plain_text",
  "tool_ref",
  "terminal_ref",
  "approval_ref"
]);

export const zToolCallStatus = z.enum(["running", "completed", "failed", "cancelled"]);

export const zTerminalStatus = z.enum(["running", "completed", "failed", "cancelled"]);

export const zApprovalStatus = z.enum(["pending", "approved", "denied", "deferred"]);

export const zApprovalKind = z.enum(["command", "file_change", "tool", "custom"]);

export const zParticipantRole = z.enum(["primary", "secondary", "observer"]);

export const zSessionRelationType = z.enum([
  "fork",
  "subagent",
  "handoff",
  "manual"
]);

export const zContextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  lastUsedTokens: z.number().int().nonnegative().optional()
});

export const zConversationSchema = z.object({
  conversationId: zConversationId,
  workspaceId: z.string().min(1).optional(),
  participantEngineIds: z.array(zEngineId).default([]),
  activeSessionId: zSessionId.optional(),
  sessionIds: z.array(zSessionId).default([]),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
  archivedAt: zIsoDateTime.optional(),
  metadata: zJsonRecord.optional()
});

export const zChatSessionSchema = z.object({
  sessionId: zSessionId,
  conversationId: zConversationId,
  engineId: zEngineId,
  status: zSessionStatus,
  title: z.string().min(1).optional(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
  archivedAt: zIsoDateTime.optional(),
  lastTurnId: zTurnId.optional(),
  contextUsage: zContextUsageSchema.optional(),
  metadata: zJsonRecord.optional()
});

const zTurnActorRef = zActorRef.optional();

export const zTurnSchema = z.object({
  turnId: zTurnId,
  sessionId: zSessionId,
  status: zTurnStatus,
  finishReason: zTurnFinishReason.optional(),
  startedAt: zIsoDateTime,
  completedAt: zIsoDateTime.optional(),
  actor: zTurnActorRef,
  finalMessageId: zMessageId.optional(),
  messageIds: z.array(zMessageId).default([]),
  toolCallIds: z.array(zToolCallId).default([]),
  terminalIds: z.array(zTerminalId).default([]),
  approvalRequestIds: z.array(zRequestId).default([])
});

const zMessageBlockActorRef = zActorRef.optional();

export const zMessageBlockSchema = z.object({
  blockId: z.string().min(1),
  messageId: zMessageId,
  sessionId: zSessionId,
  turnId: zTurnId,
  role: zMessageRole,
  kind: zMessageBlockKind,
  text: z.string().optional(),
  toolCallId: zToolCallId.optional(),
  terminalId: zTerminalId.optional(),
  requestId: zRequestId.optional(),
  actor: zMessageBlockActorRef,
  startedAt: zIsoDateTime,
  completedAt: zIsoDateTime.optional()
});

const zToolActorRef = zActorRef.optional();

export const zToolCallSchema = z.object({
  toolCallId: zToolCallId,
  sessionId: zSessionId,
  turnId: zTurnId,
  toolName: z.string().min(1),
  status: zToolCallStatus,
  inputSummary: z.string().optional(),
  outputSummary: z.string().optional(),
  actor: zToolActorRef,
  startedAt: zIsoDateTime,
  completedAt: zIsoDateTime.optional()
});

const zTerminalActorRef = zActorRef.optional();

export const zTerminalStreamSchema = z.object({
  terminalId: zTerminalId,
  sessionId: zSessionId,
  turnId: zTurnId,
  toolCallId: zToolCallId.optional(),
  status: zTerminalStatus,
  outputText: z.string().default(""),
  exitCode: z.number().int().optional(),
  actor: zTerminalActorRef,
  startedAt: zIsoDateTime,
  completedAt: zIsoDateTime.optional()
});

const zApprovalActorRef = zActorRef.optional();

export const zApprovalRequestSchema = z.object({
  requestId: zRequestId,
  sessionId: zSessionId,
  turnId: zTurnId,
  approvalKind: zApprovalKind,
  status: zApprovalStatus,
  title: z.string().min(1),
  details: z.string().optional(),
  note: z.string().optional(),
  actor: zApprovalActorRef,
  requestedAt: zIsoDateTime,
  resolvedAt: zIsoDateTime.optional()
});

export const zAgentParticipantSchema = z.object({
  participantId: zParticipantId,
  conversationId: zConversationId,
  engineId: zEngineId,
  role: zParticipantRole,
  capabilities: z.array(z.string().min(1)).default([]),
  activeSessionIds: z.array(zSessionId).default([]),
  metadata: zJsonRecord.optional()
});

export const zSessionRelationSchema = z.object({
  relationId: z.string().min(1),
  parentSessionId: zSessionId,
  childSessionId: zSessionId,
  relationType: zSessionRelationType,
  sourceTurnId: zTurnId.optional(),
  createdAt: zIsoDateTime,
  metadata: zJsonRecord.optional()
});

export const zDomainSnapshotSchema = z.object({
  conversations: z.array(zConversationSchema).default([]),
  sessions: z.array(zChatSessionSchema).default([]),
  turns: z.array(zTurnSchema).default([]),
  messageBlocks: z.array(zMessageBlockSchema).default([]),
  toolCalls: z.array(zToolCallSchema).default([]),
  terminalStreams: z.array(zTerminalStreamSchema).default([]),
  approvalRequests: z.array(zApprovalRequestSchema).default([]),
  participants: z.array(zAgentParticipantSchema).default([]),
  sessionRelations: z.array(zSessionRelationSchema).default([])
});

export type SessionStatus = z.infer<typeof zSessionStatus>;
export type TurnStatus = z.infer<typeof zTurnStatus>;
export type TurnFinishReason = z.infer<typeof zTurnFinishReason>;
export type MessageRole = z.infer<typeof zMessageRole>;
export type MessageBlockKind = z.infer<typeof zMessageBlockKind>;
export type ToolCallStatus = z.infer<typeof zToolCallStatus>;
export type TerminalStatus = z.infer<typeof zTerminalStatus>;
export type ApprovalStatus = z.infer<typeof zApprovalStatus>;
export type ApprovalKind = z.infer<typeof zApprovalKind>;
export type ParticipantRole = z.infer<typeof zParticipantRole>;
export type SessionRelationType = z.infer<typeof zSessionRelationType>;
export type ContextUsage = z.infer<typeof zContextUsageSchema>;

export type Conversation = z.infer<typeof zConversationSchema>;
export type ChatSession = z.infer<typeof zChatSessionSchema>;
export type Turn = z.infer<typeof zTurnSchema>;
export type MessageBlock = z.infer<typeof zMessageBlockSchema>;
export type ToolCall = z.infer<typeof zToolCallSchema>;
export type TerminalStream = z.infer<typeof zTerminalStreamSchema>;
export type ApprovalRequest = z.infer<typeof zApprovalRequestSchema>;
export type AgentParticipant = z.infer<typeof zAgentParticipantSchema>;
export type SessionRelation = z.infer<typeof zSessionRelationSchema>;
export type DomainSnapshot = z.infer<typeof zDomainSnapshotSchema>;

export const parseConversation = (value: unknown): Conversation =>
  zConversationSchema.parse(value);
export const parseChatSession = (value: unknown): ChatSession =>
  zChatSessionSchema.parse(value);
export const parseTurn = (value: unknown): Turn => zTurnSchema.parse(value);
export const parseMessageBlock = (value: unknown): MessageBlock =>
  zMessageBlockSchema.parse(value);
export const parseToolCall = (value: unknown): ToolCall =>
  zToolCallSchema.parse(value);
export const parseTerminalStream = (value: unknown): TerminalStream =>
  zTerminalStreamSchema.parse(value);
export const parseApprovalRequest = (value: unknown): ApprovalRequest =>
  zApprovalRequestSchema.parse(value);
export const parseAgentParticipant = (value: unknown): AgentParticipant =>
  zAgentParticipantSchema.parse(value);
export const parseSessionRelation = (value: unknown): SessionRelation =>
  zSessionRelationSchema.parse(value);
export const parseDomainSnapshot = (value: unknown): DomainSnapshot =>
  zDomainSnapshotSchema.parse(value);

