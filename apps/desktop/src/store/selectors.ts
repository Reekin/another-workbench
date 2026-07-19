import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  MessageBlock,
  SessionRelation,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import type { DomainReadModel } from "@another-workbench/core";
import type { RendererStoreState } from "./types.js";

const byIds = <T>(map: Record<string, T>, ids: readonly string[]): T[] =>
  ids.map((id) => map[id]).filter((item): item is T => Boolean(item));

const compareIsoDesc = (left?: string, right?: string): number => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return right.localeCompare(left);
};

export type SessionSummary = {
  session: ChatSession;
  parentSessionId?: string;
  childSessionIds: string[];
  relationIds: string[];
  isActive: boolean;
  isArchived: boolean;
};

export type SessionGraph = {
  summaries: SessionSummary[];
  relationEdges: SessionRelation[];
  rootSessionIds: string[];
};

export const selectConversations = (
  state: RendererStoreState
): Conversation[] => Object.values(state.entities.conversations);

export const selectConversationById = (
  state: RendererStoreState,
  conversationId: string
): Conversation | undefined => state.entities.conversations[conversationId];

export const selectSessionsForConversation = (
  state: RendererStoreState,
  conversationId: string
): ChatSession[] =>
  byIds(
    state.entities.sessions,
    state.indexes.sessionIdsByConversation[conversationId] ?? []
  );

export const selectTurnsForSession = (
  state: RendererStoreState,
  sessionId: string
): Turn[] => byIds(state.entities.turns, state.indexes.turnIdsBySession[sessionId] ?? []);

export const selectMessageBlocksForMessage = (
  state: RendererStoreState,
  messageId: string
): MessageBlock[] =>
  byIds(
    state.entities.messageBlocks,
    state.indexes.messageBlockIdsByMessage[messageId] ?? []
  );

export const selectToolCallsForTurn = (
  state: RendererStoreState,
  turnId: string
): ToolCall[] =>
  Object.values(state.entities.toolCalls).filter((item) => item.turnId === turnId);

export const selectTerminalStreamsForTurn = (
  state: RendererStoreState,
  turnId: string
): TerminalStream[] =>
  Object.values(state.entities.terminalStreams).filter((item) => item.turnId === turnId);

export const selectApprovalRequestsForTurn = (
  state: RendererStoreState,
  turnId: string
): ApprovalRequest[] =>
  Object.values(state.entities.approvalRequests).filter((item) => item.turnId === turnId);

export const selectParticipantsForConversation = (
  state: RendererStoreState,
  conversationId: string
): AgentParticipant[] =>
  byIds(
    state.entities.participants,
    state.indexes.participantIdsByConversation[conversationId] ?? []
  );

export const selectSessionRelationsForParent = (
  state: RendererStoreState,
  parentSessionId: string
): SessionRelation[] =>
  byIds(
    state.entities.sessionRelations,
    state.indexes.relationIdsByParentSession[parentSessionId] ?? []
  );

export const selectSessionRelationsForChild = (
  state: RendererStoreState,
  childSessionId: string
): SessionRelation[] =>
  byIds(
    state.entities.sessionRelations,
    state.indexes.relationIdsByChildSession[childSessionId] ?? []
  );

export const selectSessionSummary = (
  domain: DomainReadModel,
  sessionId: string
): SessionSummary | undefined => {
  const session = domain.getSession(sessionId);
  if (!session) {
    return undefined;
  }

  const parentRelations = domain.listSessionRelations({ childSessionId: sessionId });
  const childRelations = domain.listSessionRelations({ parentSessionId: sessionId });
  const conversation = domain.getConversation(session.conversationId);

  return {
    session,
    parentSessionId: parentRelations[0]?.parentSessionId,
    childSessionIds: childRelations.map((relation) => relation.childSessionId),
    relationIds: [
      ...parentRelations.map((relation) => relation.relationId),
      ...childRelations.map((relation) => relation.relationId)
    ],
    isActive: conversation?.activeSessionId === sessionId,
    isArchived: Boolean(session.archivedAt)
  };
};

export const selectSessionSummariesForConversation = (
  domain: DomainReadModel,
  conversationId: string
): SessionSummary[] =>
  domain.listSessions({ conversationId, includeArchived: true })
    .map((session) => selectSessionSummary(domain, session.sessionId))
    .filter((summary): summary is SessionSummary => Boolean(summary))
    .sort((left, right) => {
      const byUpdatedAt = compareIsoDesc(
        left.session.updatedAt,
        right.session.updatedAt
      );
      if (byUpdatedAt !== 0) {
        return byUpdatedAt;
      }
      return left.session.sessionId.localeCompare(right.session.sessionId);
    });

export const selectSessionGraphForConversation = (
  domain: DomainReadModel,
  conversationId: string
): SessionGraph => {
  const summaries = selectSessionSummariesForConversation(domain, conversationId);
  const sessionIds = new Set(summaries.map((summary) => summary.session.sessionId));
  const relationEdges = domain.listSessionRelations().filter(
    (relation) =>
      sessionIds.has(relation.parentSessionId) || sessionIds.has(relation.childSessionId)
  );
  const childIds = new Set(relationEdges.map((relation) => relation.childSessionId));
  const rootSessionIds = summaries
    .map((summary) => summary.session.sessionId)
    .filter((sessionId) => !childIds.has(sessionId));

  return {
    summaries,
    relationEdges,
    rootSessionIds
  };
};

export const selectActiveConversation = (
  state: RendererStoreState
): Conversation | undefined =>
  state.activeConversationId
    ? state.entities.conversations[state.activeConversationId]
    : undefined;

export const selectActiveSession = (
  state: RendererStoreState
): ChatSession | undefined =>
  state.activeSessionId ? state.entities.sessions[state.activeSessionId] : undefined;

export const selectEventStreamState = (state: RendererStoreState) =>
  state.eventStream;

export const selectLastEventCursor = (
  state: RendererStoreState
): string | undefined => state.eventStream.lastCursor;
