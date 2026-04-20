import type {
  AgentAdapter,
  AgentAdapterRuntimeConfig
} from "@another-workbench/adapters";
import type {
  AgentDescriptor,
  ChatSession,
  Command,
  DomainSnapshot,
  EngineIntegrationTierRpc,
  EngineSharedCapabilityRpc,
  EngineExtensionDescriptorRpc
} from "@another-workbench/shared";

export type WorkbenchSessionListOptions = {
  conversationId?: string;
  includeArchived?: boolean;
};

export type AgentSelectionInput = {
  agentId: string;
  config?: Record<string, unknown>;
};

export type CommandReceipt = {
  commandId: string;
  commandType: Command["type"];
  accepted: boolean;
};

export type SnapshotResult = {
  snapshot: DomainSnapshot;
  cursor?: string;
};

export type WorkbenchAgentBinding = {
  descriptor: AgentDescriptor;
  integrationTier?: EngineIntegrationTierRpc;
  transportKind?: string;
  adapter?: AgentAdapter;
  runtimeConfig?: AgentAdapterRuntimeConfig;
  providerKind?: string;
  resolveProviderSessionId?: (sessionId: string) => string | undefined;
  sharedCapabilities?: EngineSharedCapabilityRpc[];
  extensions?: EngineExtensionDescriptorRpc[];
};

export type SessionIndexSyncRecord = {
  workspaceId?: string;
  session: Pick<
    ChatSession,
    | "sessionId"
    | "conversationId"
    | "agentId"
    | "title"
    | "createdAt"
    | "updatedAt"
    | "archivedAt"
    | "lastTurnId"
    | "metadata"
  >;
  providerKind?: string;
  providerSessionId?: string;
};
