import { z } from "zod";

export const zEngineIntegrationTierSchema = z.enum(["native", "fallback"]);

export const zEngineDefinitionRpcSchema = z.object({
  engineId: z.string().min(1),
  displayName: z.string().min(1),
  integrationTier: zEngineIntegrationTierSchema,
  transportKind: z.string().min(1).optional()
});

export const zEngineSharedCapabilitySchema = z.enum([
  "chat",
  "turnConfiguration",
  "steer",
  "tool",
  "terminal",
  "approval",
  "attachments",
  "conversationGraph",
  "goal",
  "delegation",
  "checkpoint",
  "worktree",
  "diagnostics",
  "backgroundRun"
]);

export const zEngineReasoningOptionRpcSchema = z.object({
  optionId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional()
});

export const zEngineModelRpcSchema = z.object({
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  reasoningOptions: z.array(zEngineReasoningOptionRpcSchema).default([]),
  defaultReasoningOptionId: z.string().min(1).optional(),
  isDefault: z.boolean().default(false)
});

export const zEngineModelCatalogRpcSchema = z.object({
  engineId: z.string().min(1),
  models: z.array(zEngineModelRpcSchema).default([])
});

export const zEngineExtensionDescriptorRpcSchema = z.object({
  engineId: z.string().min(1),
  key: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  available: z.boolean()
});

export const zEngineSurfaceRpcSchema = z.object({
  engineId: z.string().min(1),
  sharedCapabilities: z.array(zEngineSharedCapabilitySchema).default([]),
  extensions: z.array(zEngineExtensionDescriptorRpcSchema).default([])
});

export type EngineIntegrationTierRpc = z.infer<typeof zEngineIntegrationTierSchema>;
export type EngineDefinitionRpc = z.infer<typeof zEngineDefinitionRpcSchema>;
export type EngineSharedCapabilityRpc = z.infer<typeof zEngineSharedCapabilitySchema>;
export type EngineReasoningOptionRpc = z.infer<
  typeof zEngineReasoningOptionRpcSchema
>;
export type EngineModelRpc = z.infer<typeof zEngineModelRpcSchema>;
export type EngineModelCatalogRpc = z.infer<typeof zEngineModelCatalogRpcSchema>;
export type EngineExtensionDescriptorRpc = z.infer<
  typeof zEngineExtensionDescriptorRpcSchema
>;
export type EngineSurfaceRpc = z.infer<typeof zEngineSurfaceRpcSchema>;
