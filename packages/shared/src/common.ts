import { z } from "zod";

export const zRuntimeId = z.string().min(1);
export const zConversationId = z.string().min(1);
export const zSessionId = z.string().min(1);
export const zTurnId = z.string().min(1);
export const zMessageId = z.string().min(1);
export const zToolCallId = z.string().min(1);
export const zTerminalId = z.string().min(1);
export const zParticipantId = z.string().min(1);
export const zEngineId = z.string().min(1);
export const zAgentId = zEngineId;
export const zRequestId = z.string().min(1);
export const zEventId = z.string().min(1);
export const zCursor = z.string().min(1);

export const zIsoDateTime = z.string().datetime({ offset: true });

export const zJsonRecord = z.record(z.unknown());

export const zActorRef = z
  .object({
    participantId: zParticipantId.optional(),
    engineId: zEngineId.optional()
  })
  .refine(
    (value) => Boolean(value.participantId || value.engineId),
    "Either participantId or engineId is required."
  );

export type ActorRef = z.infer<typeof zActorRef>;
