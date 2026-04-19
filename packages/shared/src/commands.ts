import { z } from "zod";
import {
  zAgentId,
  zConversationId,
  zIsoDateTime,
  zJsonRecord,
  zMessageId,
  zRequestId,
  zRuntimeId,
  zSessionId,
  zTurnId
} from "./common.js";

export const commandTypes = [
  "initialize",
  "createSession",
  "listSessions",
  "resumeSession",
  "archiveSession",
  "forkSession",
  "sendUserMessage",
  "interruptTurn",
  "respondApproval",
  "disposeSession"
] as const;

export type CommandType = (typeof commandTypes)[number];

const zAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mimeType: z.string().min(1),
  uri: z.string().min(1),
  name: z.string().min(1).optional()
});

const zInitializeCommand = z.object({
  type: z.literal("initialize"),
  runtimeId: zRuntimeId.optional(),
  requestedCapabilities: z.array(z.string().min(1)).optional()
});

const zCreateSessionCommand = z.object({
  type: z.literal("createSession"),
  agentId: zAgentId,
  conversationId: zConversationId.optional(),
  workspaceId: z.string().min(1).optional(),
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
  attachments: z.array(zAttachmentSchema).default([])
});

const zInterruptTurnCommand = z.object({
  type: z.literal("interruptTurn"),
  sessionId: zSessionId,
  turnId: zTurnId,
  reason: z.string().optional()
});

const zRespondApprovalCommand = z.object({
  type: z.literal("respondApproval"),
  sessionId: zSessionId,
  requestId: zRequestId,
  action: z.enum(["approve", "deny", "defer"]),
  note: z.string().optional()
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
  zInterruptTurnCommand,
  zRespondApprovalCommand,
  zDisposeSessionCommand
]);

export const zCommandEnvelopeSchema = z.object({
  commandId: zRequestId,
  issuedAt: zIsoDateTime.optional(),
  command: zCommandSchema
});

export type Attachment = z.infer<typeof zAttachmentSchema>;
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
