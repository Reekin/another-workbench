import { z } from "zod";
import type { ChatSession } from "./domain.js";
import { zJsonRecord } from "./common.js";

export const sessionProfileMetadataKey = "sessionProfile";

export const zSessionExecutionProfileSchema = z.object({
  engineId: z.string().min(1),
  modeId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningOptionId: z.string().min(1).optional(),
  serviceTierId: z.string().min(1).nullable().optional()
});

export const zSessionExecutionProfileInputSchema = z.object({
  modeId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningOptionId: z.string().min(1).optional(),
  serviceTierId: z.string().min(1).nullable().optional()
});

export type SessionExecutionProfile = z.infer<
  typeof zSessionExecutionProfileSchema
>;
export type SessionExecutionProfileInput = z.infer<
  typeof zSessionExecutionProfileInputSchema
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
  engineId?: string;
  sessionEngineId: ChatSession["engineId"];
  metadata?: Record<string, unknown>;
}): SessionExecutionProfile => {
  const existing = readSessionExecutionProfile(input.metadata);
  if (existing) {
    return existing;
  }
  return {
    engineId: input.engineId ?? input.sessionEngineId
  };
};
