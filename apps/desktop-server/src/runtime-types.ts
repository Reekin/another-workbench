import type {
  AgentAdapter,
  AgentAdapterRuntimeConfig
} from "@another-workbench/adapters";
import type {
  ChatSession,
  Command,
  DomainSnapshot,
  EventEnvelope,
  EngineIntegrationTierRpc,
  EngineSharedCapabilityRpc,
  EngineExtensionDescriptorRpc
} from "@another-workbench/shared";

export type WorkbenchEngineDescriptor = {
  engineId: string;
  displayName: string;
  capabilities: string[];
};

export type WorkbenchSessionListOptions = {
  conversationId?: string;
  includeArchived?: boolean;
};

export type EngineSelectionInput = {
  engineId: string;
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

export type EventReplayGapReason = "cursor_not_found";

export type EventReplayResult = {
  status: "ok" | "gap";
  reason?: EventReplayGapReason;
  replayed: number;
  fromCursor?: string;
  toCursor?: string;
  envelopes: EventEnvelope[];
};

export type WorkbenchAgentBinding = {
  descriptor: WorkbenchEngineDescriptor;
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
    | "engineId"
    | "title"
    | "createdAt"
    | "updatedAt"
    | "archivedAt"
    | "lastTurnId"
    | "metadata"
  >;
  providerKind?: string;
  providerSessionId?: string;
  lastCompletedTurnAt?: string;
};
