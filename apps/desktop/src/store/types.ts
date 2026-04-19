import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  DomainSnapshot,
  EventEnvelope,
  MessageBlock,
  RuntimeEvent,
  SessionRelation,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";

export type IdMap<T> = Record<string, T>;

export type RendererEntities = {
  conversations: IdMap<Conversation>;
  sessions: IdMap<ChatSession>;
  turns: IdMap<Turn>;
  messageBlocks: IdMap<MessageBlock>;
  toolCalls: IdMap<ToolCall>;
  terminalStreams: IdMap<TerminalStream>;
  approvalRequests: IdMap<ApprovalRequest>;
  participants: IdMap<AgentParticipant>;
  sessionRelations: IdMap<SessionRelation>;
};

export type RendererIndexes = {
  sessionIdsByConversation: Record<string, string[]>;
  turnIdsBySession: Record<string, string[]>;
  messageBlockIdsByMessage: Record<string, string[]>;
  participantIdsByConversation: Record<string, string[]>;
  relationIdsByParentSession: Record<string, string[]>;
  relationIdsByChildSession: Record<string, string[]>;
};

export type RendererStoreState = {
  entities: RendererEntities;
  indexes: RendererIndexes;
  eventStream: {
    lastEventId?: string;
    lastCursor?: string;
    lastOccurredAt?: string;
    recentEventIds: string[];
    seenEventIds: Record<string, true>;
  };
  activeConversationId?: string;
  activeSessionId?: string;
  lastEventType?: RuntimeEvent["type"];
  lastError?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
};

export type RendererStoreAction =
  | { type: "store/hydrateSnapshot"; snapshot: DomainSnapshot }
  | {
      type: "store/hydrateSessionWindow";
      sessionId: string;
      snapshot: DomainSnapshot;
      mode?: "replace" | "prepend";
    }
  | { type: "store/disposeSession"; sessionId: string }
  | { type: "store/ingestEvent"; event: RuntimeEvent }
  | { type: "store/ingestEnvelope"; envelope: EventEnvelope }
  | { type: "store/setActiveConversation"; conversationId?: string }
  | { type: "store/setActiveSession"; sessionId?: string };
