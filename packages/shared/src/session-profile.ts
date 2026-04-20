import { z } from "zod";
import type { ChatSession } from "./domain.js";
import { zAgentId, zJsonRecord } from "./common.js";

export const sessionProfileMetadataKey = "sessionProfile";

export const zSessionExecutionProfileSchema = z.object({
  engineId: zAgentId,
  modeId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional()
});

export type SessionExecutionProfile = z.infer<
  typeof zSessionExecutionProfileSchema
>;

export const readSessionExecutionProfile = (
  metadata: Record<string, unknown> | undefined
): SessionExecutionProfile | undefined => {
  if (!metadata) {
    return undefined;
  }
  const candidate = metadata[sessionProfileMetadataKey];
  const parsed = zSessionExecutionProfileSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

export const writeSessionExecutionProfile = (
  metadata: Record<string, unknown> | undefined,
  profile: SessionExecutionProfile
): Record<string, unknown> => {
  const base = metadata ? zJsonRecord.parse(metadata) : {};
  return {
    ...base,
    [sessionProfileMetadataKey]: zSessionExecutionProfileSchema.parse(profile)
  };
};

export const resolveSessionExecutionProfile = (input: {
  agentId: ChatSession["agentId"];
  metadata?: Record<string, unknown>;
}): SessionExecutionProfile => {
  return (
    readSessionExecutionProfile(input.metadata) ?? {
      engineId: input.agentId
    }
  );
};
