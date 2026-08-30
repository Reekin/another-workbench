import { z } from "zod";
import {
  zConversationId,
  zIsoDateTime,
  zJsonRecord,
  zMessageId,
  zRequestId,
  zRuntimeId,
  zSessionId,
  zTurnId
} from "./common.js";
import { zSessionExecutionProfileInputSchema } from "./session-profile.js";

export const commandTypes = [
  "initialize",
  "createSession",
  "listSessions",
  "resumeSession",
  "archiveSession",
  "forkSession",
  "sendUserMessage",
  "steerTurn",
  "interruptTurn",
  "setThreadGoal",
  "clearThreadGoal",
  "respondApproval",
  "respondInteraction",
  "disposeSession"
] as const;

export type CommandType = (typeof commandTypes)[number];

const zAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mimeType: z.string().min(1),
  uri: z.string().min(1),
  displayUri: z.string().min(1).optional(),
  name: z.string().min(1).optional()
});

export const zTurnExecutionOptionsSchema = z.object({
  modelId: z.string().min(1).optional(),
  reasoningOptionId: z.string().min(1).optional(),
  serviceTierId: z.string().min(1).nullable().optional()
});

const zInitializeCommand = z.object({
  type: z.literal("initialize"),
  runtimeId: zRuntimeId.optional(),
  requestedCapabilities: z.array(z.string().min(1)).optional()
});

const zCreateSessionCommand = z.object({
  type: z.literal("createSession"),
  engineId: z.string().min(1),
  conversationId: zConversationId.optional(),
  workspaceId: z.string().min(1).optional(),
  sessionProfile: zSessionExecutionProfileInputSchema.optional(),
  metadata: zJsonRecord.optional()
});

const zListSessionsCommand = z.object({
  type: z.literal("listSessions"),
  conversationId: zConversationId.optional(),
  includeArchived: z.boolean().default(false)
});

const zResumeSessionCommand = z.object({
  type: z.literal("resumeSession"),
  sessionId: zSessionId
});

const zArchiveSessionCommand = z.object({
  type: z.literal("archiveSession"),
  sessionId: zSessionId
});

const zForkSessionCommand = z.object({
  type: z.literal("forkSession"),
  sessionId: zSessionId,
  fromTurnId: zTurnId.optional()
});

const zSendUserMessageCommand = z.object({
  type: z.literal("sendUserMessage"),
  sessionId: zSessionId,
  messageId: zMessageId,
  content: z.string(),
  attachments: z.array(zAttachmentSchema).default([]),
  execution: zTurnExecutionOptionsSchema.optional(),
  cwd: z.string().min(1).optional()
});

const zSteerTurnCommand = z.object({
  type: z.literal("steerTurn"),
  sessionId: zSessionId,
  turnId: zTurnId,
  messageId: zMessageId,
  content: z.string(),
  attachments: z.array(zAttachmentSchema).default([]),
  cwd: z.string().min(1).optional()
});

const zInterruptTurnCommand = z.object({
  type: z.literal("interruptTurn"),
  sessionId: zSessionId,
  turnId: zTurnId,
  reason: z.string().optional(),
  cwd: z.string().min(1).optional()
});

const zSetThreadGoalCommand = z.object({
  type: z.literal("setThreadGoal"),
  sessionId: zSessionId,
  objective: z.string().min(1).optional(),
  status: z
    .enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"])
    .optional(),
  tokenBudget: z.number().int().positive().nullable().optional(),
  cwd: z.string().min(1).optional()
});

const zClearThreadGoalCommand = z.object({
  type: z.literal("clearThreadGoal"),
  sessionId: zSessionId,
  cwd: z.string().min(1).optional()
});

const zRespondApprovalCommand = z.object({
  type: z.literal("respondApproval"),
  sessionId: zSessionId,
  requestId: zRequestId,
  action: z.enum(["approve", "deny", "defer"]),
  decision: z.union([z.string().min(1), zJsonRecord]).optional(),
  payload: zJsonRecord.optional(),
  note: z.string().optional(),
  cwd: z.string().min(1).optional()
});

const zRespondInteractionCommand = z.object({
  type: z.literal("respondInteraction"),
  sessionId: zSessionId,
  requestId: zRequestId,
  action: z.enum(["accept", "decline", "cancel", "submit", "defer"]),
  response: zJsonRecord.optional(),
  content: z.unknown().optional(),
  answers: z.record(z.array(z.string())).optional(),
  meta: zJsonRecord.optional(),
  cwd: z.string().min(1).optional()
});

const zDisposeSessionCommand = z.object({
  type: z.literal("disposeSession"),
  sessionId: zSessionId
});

export const zCommandSchema = z.discriminatedUnion("type", [
  zInitializeCommand,
  zCreateSessionCommand,
  zListSessionsCommand,
  zResumeSessionCommand,
  zArchiveSessionCommand,
  zForkSessionCommand,
  zSendUserMessageCommand,
  zSteerTurnCommand,
  zInterruptTurnCommand,
  zSetThreadGoalCommand,
  zClearThreadGoalCommand,
  zRespondApprovalCommand,
  zRespondInteractionCommand,
  zDisposeSessionCommand
]);

export const zCommandEnvelopeSchema = z.object({
  commandId: zRequestId,
  issuedAt: zIsoDateTime.optional(),
  command: zCommandSchema
});

export type Attachment = z.infer<typeof zAttachmentSchema>;
export type TurnExecutionOptions = z.infer<typeof zTurnExecutionOptionsSchema>;
export type Command = z.infer<typeof zCommandSchema>;
export type CommandEnvelope = z.infer<typeof zCommandEnvelopeSchema>;

export const parseCommand = (value: unknown): Command =>
  zCommandSchema.parse(value);

export const parseCommandEnvelope = (value: unknown): CommandEnvelope =>
  zCommandEnvelopeSchema.parse(value);

export const safeParseCommand = (value: unknown) =>
  zCommandSchema.safeParse(value);

export const safeParseCommandEnvelope = (value: unknown) =>
  zCommandEnvelopeSchema.safeParse(value);

export const isCommandType = (value: string): value is CommandType =>
  (commandTypes as readonly string[]).includes(value);
