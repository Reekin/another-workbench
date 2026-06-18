import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  MessageBlock,
  RuntimeInteraction,
  SessionRelation,
  TerminalStream,
  ThreadGoal,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import type { IdMap, RendererEntities, RendererIndexes, RendererStoreState } from "./types.js";
import { createInitialRendererRefreshSignals } from "./refresh-signals.js";

const addUnique = (items: string[], value: string): string[] => {
  if (items.includes(value)) {
    return items;
  }
  return [...items, value];
};

const put = <T>(map: IdMap<T>, key: string, value: T): IdMap<T> => ({
  ...map,
  [key]: value
});

const updateListIndex = (
  index: Record<string, string[]>,
  ownerId: string,
  valueId: string
): Record<string, string[]> => ({
  ...index,
  [ownerId]: addUnique(index[ownerId] ?? [], valueId)
});

const removeFromListIndex = (
  index: Record<string, string[]>,
  ownerId: string | undefined,
  valueId: string
): Record<string, string[]> => {
  if (!ownerId) {
    return index;
  }
  const current = index[ownerId];
  if (!current?.includes(valueId)) {
    return index;
  }
  const next = current.filter((item) => item !== valueId);
  if (next.length === current.length) {
    return index;
  }
  const result = { ...index };
  if (next.length === 0) {
    delete result[ownerId];
  } else {
    result[ownerId] = next;
  }
  return result;
};

export const createEmptyEntities = (): RendererEntities => ({
  conversations: {},
  sessions: {},
  turns: {},
  messageBlocks: {},
  toolCalls: {},
  terminalStreams: {},
  approvalRequests: {},
  runtimeInteractions: {},
  participants: {},
  threadGoals: {},
  sessionRelations: {}
});

export const createEmptyIndexes = (): RendererIndexes => ({
  sessionIdsByConversation: {},
  turnIdsBySession: {},
  messageBlockIdsByMessage: {},
  messageBlockIdsByTurn: {},
  toolCallIdsByTurn: {},
  terminalIdsByTurn: {},
  approvalRequestIdsByTurn: {},
  runtimeInteractionIdsByTurn: {},
  participantIdsByConversation: {},
  relationIdsByParentSession: {},
  relationIdsByChildSession: {}
});

export const createInitialRendererStoreState = (): RendererStoreState => ({
  entities: createEmptyEntities(),
  indexes: createEmptyIndexes(),
  eventStream: {
    recentEventIds: [],
    seenEventIds: {}
  },
  refreshSignals: createInitialRendererRefreshSignals()
});

export const upsertConversation = (
  state: RendererStoreState,
  conversation: Conversation
): RendererStoreState => ({
  ...state,
  entities: {
    ...state.entities,
    conversations: put(
      state.entities.conversations,
      conversation.conversationId,
      conversation
    )
  }
});

export const upsertSession = (
  state: RendererStoreState,
  session: ChatSession
): RendererStoreState => ({
  ...state,
  entities: {
    ...state.entities,
    sessions: put(state.entities.sessions, session.sessionId, session)
  },
  indexes: {
    ...state.indexes,
    sessionIdsByConversation: updateListIndex(
      state.indexes.sessionIdsByConversation,
      session.conversationId,
      session.sessionId
    )
  }
});

export const upsertTurn = (state: RendererStoreState, turn: Turn): RendererStoreState => ({
  ...state,
  entities: {
    ...state.entities,
    turns: put(state.entities.turns, turn.turnId, turn)
  },
  indexes: {
    ...state.indexes,
    turnIdsBySession: updateListIndex(
      state.indexes.turnIdsBySession,
      turn.sessionId,
      turn.turnId
    )
  }
});

export const upsertMessageBlock = (
  state: RendererStoreState,
  messageBlock: MessageBlock
): RendererStoreState => {
  const existing = state.entities.messageBlocks[messageBlock.blockId];
  const messageBlockIdsByMessage = updateListIndex(
    removeFromListIndex(
      state.indexes.messageBlockIdsByMessage,
      existing?.messageId !== messageBlock.messageId ? existing?.messageId : undefined,
      messageBlock.blockId
    ),
    messageBlock.messageId,
    messageBlock.blockId
  );
  const messageBlockIdsByTurn = updateListIndex(
    removeFromListIndex(
      state.indexes.messageBlockIdsByTurn,
      existing?.turnId !== messageBlock.turnId ? existing?.turnId : undefined,
      messageBlock.blockId
    ),
    messageBlock.turnId,
    messageBlock.blockId
  );
  return {
    ...state,
    entities: {
      ...state.entities,
      messageBlocks: put(state.entities.messageBlocks, messageBlock.blockId, messageBlock)
    },
    indexes: {
      ...state.indexes,
      messageBlockIdsByMessage,
      messageBlockIdsByTurn
    }
  };
};

export const upsertToolCall = (
  state: RendererStoreState,
  toolCall: ToolCall
): RendererStoreState => {
  const existing = state.entities.toolCalls[toolCall.toolCallId];
  return {
    ...state,
    entities: {
      ...state.entities,
      toolCalls: put(state.entities.toolCalls, toolCall.toolCallId, toolCall)
    },
    indexes: {
      ...state.indexes,
      toolCallIdsByTurn: updateListIndex(
        removeFromListIndex(
          state.indexes.toolCallIdsByTurn,
          existing?.turnId !== toolCall.turnId ? existing?.turnId : undefined,
          toolCall.toolCallId
        ),
        toolCall.turnId,
        toolCall.toolCallId
      )
    }
  };
};

export const upsertTerminalStream = (
  state: RendererStoreState,
  terminalStream: TerminalStream
): RendererStoreState => {
  const existing = state.entities.terminalStreams[terminalStream.terminalId];
  return {
    ...state,
    entities: {
      ...state.entities,
      terminalStreams: put(
        state.entities.terminalStreams,
        terminalStream.terminalId,
        terminalStream
      )
    },
    indexes: {
      ...state.indexes,
      terminalIdsByTurn: updateListIndex(
        removeFromListIndex(
          state.indexes.terminalIdsByTurn,
          existing?.turnId !== terminalStream.turnId ? existing?.turnId : undefined,
          terminalStream.terminalId
        ),
        terminalStream.turnId,
        terminalStream.terminalId
      )
    }
  };
};

export const upsertApprovalRequest = (
  state: RendererStoreState,
  approvalRequest: ApprovalRequest
): RendererStoreState => {
  const existing = state.entities.approvalRequests[approvalRequest.requestId];
  return {
    ...state,
    entities: {
      ...state.entities,
      approvalRequests: put(
        state.entities.approvalRequests,
        approvalRequest.requestId,
        approvalRequest
      )
    },
    indexes: {
      ...state.indexes,
      approvalRequestIdsByTurn: updateListIndex(
        removeFromListIndex(
          state.indexes.approvalRequestIdsByTurn,
          existing?.turnId !== approvalRequest.turnId ? existing?.turnId : undefined,
          approvalRequest.requestId
        ),
        approvalRequest.turnId,
        approvalRequest.requestId
      )
    }
  };
};

export const upsertRuntimeInteraction = (
  state: RendererStoreState,
  runtimeInteraction: RuntimeInteraction
): RendererStoreState => {
  const existing = state.entities.runtimeInteractions[runtimeInteraction.requestId];
  const runtimeInteractionIdsByTurn = removeFromListIndex(
    state.indexes.runtimeInteractionIdsByTurn,
    existing?.turnId !== runtimeInteraction.turnId ? existing?.turnId : undefined,
    runtimeInteraction.requestId
  );
  const nextState: RendererStoreState = {
    ...state,
    entities: {
      ...state.entities,
      runtimeInteractions: put(
        state.entities.runtimeInteractions,
        runtimeInteraction.requestId,
        runtimeInteraction
      )
    }
  };
  if (!runtimeInteraction.turnId) {
    return {
      ...nextState,
      indexes: {
        ...nextState.indexes,
        runtimeInteractionIdsByTurn
      }
    };
  }
  return {
    ...nextState,
    indexes: {
      ...nextState.indexes,
      runtimeInteractionIdsByTurn: updateListIndex(
        runtimeInteractionIdsByTurn,
        runtimeInteraction.turnId,
        runtimeInteraction.requestId
      )
    }
  };
};

export const upsertParticipant = (
  state: RendererStoreState,
  participant: AgentParticipant
): RendererStoreState => ({
  ...state,
  entities: {
    ...state.entities,
    participants: put(
      state.entities.participants,
      participant.participantId,
      participant
    )
  },
  indexes: {
    ...state.indexes,
    participantIdsByConversation: updateListIndex(
      state.indexes.participantIdsByConversation,
      participant.conversationId,
      participant.participantId
    )
  }
});

export const upsertThreadGoal = (
  state: RendererStoreState,
  goal: ThreadGoal
): RendererStoreState => ({
  ...state,
  entities: {
    ...state.entities,
    threadGoals: put(state.entities.threadGoals, goal.sessionId, goal)
  }
});

export const deleteThreadGoal = (
  state: RendererStoreState,
  sessionId: string
): RendererStoreState => {
  if (!(sessionId in state.entities.threadGoals)) {
    return state;
  }
  const nextThreadGoals = { ...state.entities.threadGoals };
  delete nextThreadGoals[sessionId];
  return {
    ...state,
    entities: {
      ...state.entities,
      threadGoals: nextThreadGoals
    }
  };
};

export const upsertSessionRelation = (
  state: RendererStoreState,
  relation: SessionRelation
): RendererStoreState => ({
  ...state,
  entities: {
    ...state.entities,
    sessionRelations: put(state.entities.sessionRelations, relation.relationId, relation)
  },
  indexes: {
    ...state.indexes,
    relationIdsByParentSession: updateListIndex(
      state.indexes.relationIdsByParentSession,
      relation.parentSessionId,
      relation.relationId
    ),
    relationIdsByChildSession: updateListIndex(
      state.indexes.relationIdsByChildSession,
      relation.childSessionId,
      relation.relationId
    )
  }
});
