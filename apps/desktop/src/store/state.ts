import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  DomainSnapshot,
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

const legacyStartBlockSuffix = ":start";
const markdownBlockSuffix = ":md";

export const normalizeSnapshotMessageBlocks = (
  blocks: MessageBlock[]
): MessageBlock[] => {
  // Older snapshots produced separate start and markdown stream blocks. Keep
  // this renderer boundary normalization until shared snapshot migration owns it.
  const grouped = new Map<string, MessageBlock[]>();
  for (const block of blocks) {
    const bucket = grouped.get(block.messageId);
    if (bucket) {
      bucket.push(block);
    } else {
      grouped.set(block.messageId, [block]);
    }
  }

  const normalized: MessageBlock[] = [];
  for (const [messageId, group] of grouped.entries()) {
    const expectedStartId = `${messageId}${legacyStartBlockSuffix}`;
    const expectedMarkdownId = `${messageId}${markdownBlockSuffix}`;

    const startBlock = group.find((block) => block.blockId === expectedStartId);
    const markdownBlock = group.find((block) => block.blockId === expectedMarkdownId);

    if (markdownBlock) {
      const merged: MessageBlock = startBlock
        ? {
            ...markdownBlock,
            role: markdownBlock.role ?? startBlock.role,
            actor: markdownBlock.actor ?? startBlock.actor,
            startedAt:
              Date.parse(startBlock.startedAt) <= Date.parse(markdownBlock.startedAt)
                ? startBlock.startedAt
                : markdownBlock.startedAt
          }
        : markdownBlock;

      normalized.push(merged);
      for (const block of group) {
        if (block.blockId === expectedStartId || block.blockId === expectedMarkdownId) {
          continue;
        }
        normalized.push(block);
      }
      continue;
    }

    if (startBlock) {
      normalized.push({
        ...startBlock,
        blockId: expectedMarkdownId
      });
      for (const block of group) {
        if (block.blockId === expectedStartId) {
          continue;
        }
        normalized.push(block);
      }
      continue;
    }

    normalized.push(...group);
  }

  return normalized;
};

export const normalizeRendererDomainSnapshot = (
  snapshot: DomainSnapshot
): DomainSnapshot => ({
  ...snapshot,
  messageBlocks: normalizeSnapshotMessageBlocks(snapshot.messageBlocks)
});

export const withDomainSnapshot = (
  state: RendererStoreState,
  snapshot: DomainSnapshot
): RendererStoreState => {
  let domainState = createInitialRendererStoreState();

  for (const conversation of snapshot.conversations) {
    domainState = upsertConversation(domainState, conversation);
  }
  for (const session of snapshot.sessions) {
    domainState = upsertSession(domainState, session);
  }
  for (const turn of snapshot.turns) {
    domainState = upsertTurn(domainState, turn);
  }
  for (const block of normalizeSnapshotMessageBlocks(snapshot.messageBlocks)) {
    domainState = upsertMessageBlock(domainState, block);
  }
  for (const toolCall of snapshot.toolCalls) {
    domainState = upsertToolCall(domainState, toolCall);
  }
  for (const terminal of snapshot.terminalStreams) {
    domainState = upsertTerminalStream(domainState, terminal);
  }
  for (const approval of snapshot.approvalRequests) {
    domainState = upsertApprovalRequest(domainState, approval);
  }
  for (const interaction of snapshot.runtimeInteractions ?? []) {
    domainState = upsertRuntimeInteraction(domainState, interaction);
  }
  for (const participant of snapshot.participants) {
    domainState = upsertParticipant(domainState, participant);
  }
  for (const goal of snapshot.threadGoals ?? []) {
    domainState = upsertThreadGoal(domainState, goal);
  }
  for (const relation of snapshot.sessionRelations) {
    domainState = upsertSessionRelation(domainState, relation);
  }

  return {
    ...state,
    entities: domainState.entities,
    indexes: domainState.indexes
  };
};
