import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  DomainSnapshot,
  MessageBlock,
  SessionRelation,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import {
  parseDomainSnapshot,
  zDomainSnapshotSchema,
  zSessionRelationSchema
} from "@another-workbench/shared";

export type DomainIndexes = {
  conversationById: Map<Conversation["conversationId"], Conversation>;
  sessionById: Map<ChatSession["sessionId"], ChatSession>;
  turnById: Map<Turn["turnId"], Turn>;
  messageBlocksByMessageId: Map<MessageBlock["messageId"], MessageBlock[]>;
  toolCallById: Map<ToolCall["toolCallId"], ToolCall>;
  terminalById: Map<TerminalStream["terminalId"], TerminalStream>;
  approvalById: Map<ApprovalRequest["requestId"], ApprovalRequest>;
  participantById: Map<AgentParticipant["participantId"], AgentParticipant>;
  parentSessionIdByChild: Map<ChatSession["sessionId"], ChatSession["sessionId"]>;
  childSessionIdsByParent: Map<ChatSession["sessionId"], ChatSession["sessionId"][]>;
};

export const createEmptyDomainSnapshot = (): DomainSnapshot =>
  zDomainSnapshotSchema.parse({});

export const buildDomainIndexes = (snapshot: DomainSnapshot): DomainIndexes => {
  const conversationById = new Map(
    snapshot.conversations.map((conversation) => [
      conversation.conversationId,
      conversation
    ])
  );
  const sessionById = new Map(
    snapshot.sessions.map((session) => [session.sessionId, session])
  );
  const turnById = new Map(snapshot.turns.map((turn) => [turn.turnId, turn]));
  const toolCallById = new Map(
    snapshot.toolCalls.map((toolCall) => [toolCall.toolCallId, toolCall])
  );
  const terminalById = new Map(
    snapshot.terminalStreams.map((terminal) => [terminal.terminalId, terminal])
  );
  const approvalById = new Map(
    snapshot.approvalRequests.map((approval) => [approval.requestId, approval])
  );
  const participantById = new Map(
    snapshot.participants.map((participant) => [
      participant.participantId,
      participant
    ])
  );
  const messageBlocksByMessageId = new Map<MessageBlock["messageId"], MessageBlock[]>();
  for (const block of snapshot.messageBlocks) {
    const existing = messageBlocksByMessageId.get(block.messageId);
    if (existing) {
      existing.push(block);
      continue;
    }
    messageBlocksByMessageId.set(block.messageId, [block]);
  }

  const parentSessionIdByChild = new Map<
    ChatSession["sessionId"],
    ChatSession["sessionId"]
  >();
  const childSessionIdsByParent = new Map<
    ChatSession["sessionId"],
    ChatSession["sessionId"][]
  >();

  for (const relation of snapshot.sessionRelations) {
    parentSessionIdByChild.set(relation.childSessionId, relation.parentSessionId);
    const existingChildren = childSessionIdsByParent.get(relation.parentSessionId);
    if (existingChildren) {
      existingChildren.push(relation.childSessionId);
      continue;
    }
    childSessionIdsByParent.set(relation.parentSessionId, [relation.childSessionId]);
  }

  return {
    conversationById,
    sessionById,
    turnById,
    messageBlocksByMessageId,
    toolCallById,
    terminalById,
    approvalById,
    participantById,
    parentSessionIdByChild,
    childSessionIdsByParent
  };
};

export const getSessionChildren = (
  indexes: Pick<DomainIndexes, "childSessionIdsByParent">,
  sessionId: ChatSession["sessionId"]
): ChatSession["sessionId"][] => indexes.childSessionIdsByParent.get(sessionId) ?? [];

export const getSessionParent = (
  indexes: Pick<DomainIndexes, "parentSessionIdByChild">,
  sessionId: ChatSession["sessionId"]
): ChatSession["sessionId"] | undefined =>
  indexes.parentSessionIdByChild.get(sessionId);

export const sortSessionRelationsByCreatedAt = (
  relations: SessionRelation[]
): SessionRelation[] =>
  relations
    .map((relation) => zSessionRelationSchema.parse(relation))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const parseSnapshot = (value: unknown): DomainSnapshot =>
  parseDomainSnapshot(value);

