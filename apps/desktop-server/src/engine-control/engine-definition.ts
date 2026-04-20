import type {
  EngineDefinitionRpc,
  EngineIntegrationTierRpc
} from "@another-workbench/shared";

export type EngineDefinition = EngineDefinitionRpc & {
  integrationTier: EngineIntegrationTierRpc;
};
