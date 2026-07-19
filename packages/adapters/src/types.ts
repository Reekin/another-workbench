import type {
  CommandEnvelope,
  CommandType,
  EventEnvelope,
  EventType
} from "@another-workbench/shared";

export type AdapterKind = "codex" | "acp";

export type AdapterLifecycleState =
  | "idle"
  | "starting"
  | "ready"
  | "stopped"
  | "error";

export type AdapterEventFilter = {
  sessionId?: string;
  conversationId?: string;
  eventTypes?: EventType[];
};

export type AdapterEventListener = (envelope: EventEnvelope) => void;

export type AdapterCommandOutcome =
  | {
      type: "turn_started";
      sessionId: string;
      turnId: string;
      providerSessionId?: string;
    }
  | {
      type: "command_accepted";
    };

export type AdapterCommandResult = {
  commandId: CommandEnvelope["commandId"];
  commandType: CommandType;
  accepted: boolean;
  outcome?: AdapterCommandOutcome;
  raw?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type AgentAdapterRuntimeConfig = {
  cwd?: string;
  env?: Record<string, string>;
  auth?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export interface AgentAdapter {
  readonly id: string;
  readonly kind: AdapterKind;
  getLifecycleState(): AdapterLifecycleState;
  initialize(config?: AgentAdapterRuntimeConfig): Promise<void>;
  executeCommand(envelope: CommandEnvelope): Promise<AdapterCommandResult>;
  subscribe(
    listener: AdapterEventListener,
    filter?: AdapterEventFilter
  ): () => void;
  dispose(): Promise<void>;
}

