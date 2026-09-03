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

export const zExecutionPreferencesByEngineIdSchema = z
  .record(
    z.string(),
    z.object({
      modeId: z.string().min(1).optional(),
      selectedModelId: z.string().min(1).optional(),
      modelPreferences: z
        .record(
          z.string(),
          z.object({
            reasoningOptionId: z.string().min(1).nullable().optional(),
            serviceTierId: z.string().min(1).nullable().optional()
          })
        )
        .default({})
    })
  )
  .default({});

export type SessionExecutionProfile = z.infer<
  typeof zSessionExecutionProfileSchema
>;
export type SessionExecutionProfileInput = z.infer<
  typeof zSessionExecutionProfileInputSchema
>;
export type ExecutionPreferencesByEngineId = z.infer<
  typeof zExecutionPreferencesByEngineIdSchema
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

export const resolveEngineExecutionPreference = (
  preferences: ExecutionPreferencesByEngineId[string] | undefined
): SessionExecutionProfileInput | undefined => {
  const modelId = preferences?.selectedModelId;
  if (!modelId) {
    return preferences?.modeId ? { modeId: preferences.modeId } : undefined;
  }
  return {
    modeId: preferences.modeId,
    modelId,
    reasoningOptionId:
      preferences.modelPreferences[modelId]?.reasoningOptionId ?? undefined,
    serviceTierId: preferences.modelPreferences[modelId]?.serviceTierId
  };
};

export const writeEngineExecutionPreference = (
  current: ExecutionPreferencesByEngineId,
  engineId: string,
  execution: {
    modeId?: string;
    modelId: string;
    reasoningOptionId?: string;
    serviceTierId?: string | null;
  }
): ExecutionPreferencesByEngineId => {
  const engine = current[engineId];
  return {
    ...current,
    [engineId]: {
      ...engine,
      ...(execution.modeId !== undefined ? { modeId: execution.modeId } : {}),
      selectedModelId: execution.modelId,
      modelPreferences: {
        ...engine?.modelPreferences,
        [execution.modelId]: {
          reasoningOptionId: execution.reasoningOptionId ?? null,
          serviceTierId: execution.serviceTierId
        }
      }
    }
  };
};
