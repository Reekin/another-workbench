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
  parseAgentParticipant,
  parseApprovalRequest,
  parseChatSession,
  parseConversation,
  parseDomainSnapshot,
  parseMessageBlock,
  parseSessionRelation,
  parseTerminalStream,
  parseToolCall,
  parseTurn
} from "@another-workbench/shared";
import { createEmptyDomainSnapshot } from "./domain.js";

export type DomainStoreOptions = {
  snapshot?: DomainSnapshot;
};

export type ListSessionsOptions = {
  conversationId?: string;
  engineId?: string;
  includeArchived?: boolean;
};

export type ListTurnsOptions = {
  sessionId?: string;
};

export type ListMessageBlocksOptions = {
  sessionId?: string;
  turnId?: string;
  messageId?: string;
};

export type ListToolCallsOptions = {
  sessionId?: string;
  turnId?: string;
};

export type ListTerminalStreamsOptions = {
  sessionId?: string;
  turnId?: string;
};

export type ListApprovalRequestsOptions = {
  sessionId?: string;
  turnId?: string;
};

export type ListParticipantsOptions = {
  conversationId?: string;
  engineId?: string;
};

export type ListSessionRelationsOptions = {
  sessionId?: string;
  parentSessionId?: string;
  childSessionId?: string;
};

const compareIsoAsc = (left?: string, right?: string): number => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  return left.localeCompare(right);
};

const sortByIsoAsc = <T>(
  values: Iterable<T>,
  selectIso: (item: T) => string | undefined,
  selectId: (item: T) => string
): T[] =>
  [...values].sort((left, right) => {
    const byIso = compareIsoAsc(selectIso(left), selectIso(right));
    if (byIso !== 0) {
      return byIso;
    }
    return selectId(left).localeCompare(selectId(right));
  });

const sortSessionsByUpdatedAtDesc = (sessions: Iterable<ChatSession>): ChatSession[] =>
  [...sessions].sort((left, right) => {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });

const addUniqueValue = (map: Map<string, string[]>, key: string, value: string): void => {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [value]);
    return;
  }
  if (!existing.includes(value)) {
    existing.push(value);
  }
};

const removeIndexedValue = (
  map: Map<string, string[]>,
  key: string | undefined,
  value: string
): void => {
  if (!key) {
    return;
  }
  const existing = map.get(key);
  if (!existing) {
    return;
  }
  const nextValues = existing.filter((entry) => entry !== value);
  if (nextValues.length === 0) {
    map.delete(key);
    return;
  }
  map.set(key, nextValues);
};

const mapIdsToValues = <T>(
  ids: readonly string[] | undefined,
  getValue: (id: string) => T | undefined
): T[] => {
  if (!ids) {
    return [];
  }
  return ids
    .map((id) => getValue(id))
    .filter((value): value is T => value !== undefined);
};

export class DomainStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly sessions = new Map<string, ChatSession>();
  private readonly turns = new Map<string, Turn>();
  private readonly messageBlocks = new Map<string, MessageBlock>();
  private readonly toolCalls = new Map<string, ToolCall>();
  private readonly terminalStreams = new Map<string, TerminalStream>();
  private readonly approvalRequests = new Map<string, ApprovalRequest>();
  private readonly participants = new Map<string, AgentParticipant>();
  private readonly sessionRelations = new Map<string, SessionRelation>();

  private readonly sessionIdsByConversation = new Map<string, string[]>();
  private readonly turnIdsBySession = new Map<string, string[]>();
  private readonly messageBlockIdsByTurn = new Map<string, string[]>();
  private readonly messageBlockIdsByMessage = new Map<string, string[]>();
  private readonly toolCallIdsByTurn = new Map<string, string[]>();
  private readonly terminalIdsByTurn = new Map<string, string[]>();
  private readonly approvalRequestIdsByTurn = new Map<string, string[]>();
  private readonly participantIdsByConversation = new Map<string, string[]>();
  private readonly parentSessionIdByChild = new Map<string, string>();
  private readonly childSessionIdsByParent = new Map<string, string[]>();

  public constructor(options: DomainStoreOptions = {}) {
    if (options.snapshot) {
      this.replaceSnapshot(options.snapshot);
    }
  }

  public clear(): void {
    this.conversations.clear();
    this.sessions.clear();
    this.turns.clear();
    this.messageBlocks.clear();
    this.toolCalls.clear();
    this.terminalStreams.clear();
    this.approvalRequests.clear();
    this.participants.clear();
    this.sessionRelations.clear();

    this.sessionIdsByConversation.clear();
    this.turnIdsBySession.clear();
    this.messageBlockIdsByTurn.clear();
    this.messageBlockIdsByMessage.clear();
    this.toolCallIdsByTurn.clear();
    this.terminalIdsByTurn.clear();
    this.approvalRequestIdsByTurn.clear();
    this.participantIdsByConversation.clear();
    this.parentSessionIdByChild.clear();
    this.childSessionIdsByParent.clear();
  }

  public replaceSnapshot(snapshot: DomainSnapshot | unknown): DomainSnapshot {
    const parsedSnapshot = parseDomainSnapshot(snapshot);
    this.clear();

    for (const conversation of parsedSnapshot.conversations) {
      this.upsertConversation(conversation);
    }
    for (const session of parsedSnapshot.sessions) {
      this.upsertSession(session);
    }
    for (const turn of parsedSnapshot.turns) {
      this.upsertTurn(turn);
    }
    for (const block of parsedSnapshot.messageBlocks) {
      this.upsertMessageBlock(block);
    }
    for (const toolCall of parsedSnapshot.toolCalls) {
      this.upsertToolCall(toolCall);
    }
    for (const terminalStream of parsedSnapshot.terminalStreams) {
      this.upsertTerminalStream(terminalStream);
    }
    for (const approvalRequest of parsedSnapshot.approvalRequests) {
      this.upsertApprovalRequest(approvalRequest);
    }
    for (const participant of parsedSnapshot.participants) {
      this.upsertParticipant(participant);
    }
    for (const relation of parsedSnapshot.sessionRelations) {
      this.upsertSessionRelation(relation);
    }

    return this.getSnapshot();
  }

  public getSnapshot(): DomainSnapshot {
    return {
      conversations: sortByIsoAsc(
        this.conversations.values(),
        (conversation) => conversation.createdAt,
        (conversation) => conversation.conversationId
      ),
      sessions: this.listSessions({ includeArchived: true }),
      turns: sortByIsoAsc(
        this.turns.values(),
        (turn) => turn.startedAt,
        (turn) => turn.turnId
      ),
      messageBlocks: sortByIsoAsc(
        this.messageBlocks.values(),
        (block) => block.startedAt,
        (block) => block.blockId
      ),
      toolCalls: sortByIsoAsc(
        this.toolCalls.values(),
        (toolCall) => toolCall.startedAt,
        (toolCall) => toolCall.toolCallId
      ),
      terminalStreams: sortByIsoAsc(
        this.terminalStreams.values(),
        (stream) => stream.startedAt,
        (stream) => stream.terminalId
      ),
      approvalRequests: sortByIsoAsc(
        this.approvalRequests.values(),
        (approval) => approval.requestedAt,
        (approval) => approval.requestId
      ),
      participants: [...this.participants.values()].sort((left, right) =>
        left.participantId.localeCompare(right.participantId)
      ),
      sessionRelations: sortByIsoAsc(
        this.sessionRelations.values(),
        (relation) => relation.createdAt,
        (relation) => relation.relationId
      )
    };
  }

  public getConversationSnapshot(conversationId: string): DomainSnapshot {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return createEmptyDomainSnapshot();
    }

    const sessions = this.listSessions({
      conversationId,
      includeArchived: true
    });
    const sessionIds = new Set(sessions.map((session) => session.sessionId));
    const turns = sessions.flatMap((session) =>
      this.listTurns({ sessionId: session.sessionId })
    );
    const sessionRelations = this.listSessionRelations().filter(
      (relation) =>
        sessionIds.has(relation.parentSessionId) || sessionIds.has(relation.childSessionId)
    );

    return {
      conversations: [conversation],
      sessions,
      turns,
      messageBlocks: turns.flatMap((turn) =>
        this.listMessageBlocks({ turnId: turn.turnId })
      ),
      toolCalls: turns.flatMap((turn) => this.listToolCalls({ turnId: turn.turnId })),
      terminalStreams: turns.flatMap((turn) =>
        this.listTerminalStreams({ turnId: turn.turnId })
      ),
      approvalRequests: turns.flatMap((turn) =>
        this.listApprovalRequests({ turnId: turn.turnId })
      ),
      participants: this.listParticipants({ conversationId }),
      sessionRelations
    };
  }

  public getSessionSnapshot(sessionId: string): DomainSnapshot {
    const session = this.getSession(sessionId);
    if (!session) {
      return createEmptyDomainSnapshot();
    }

    const conversation = this.getConversation(session.conversationId);
    const turns = this.listTurns({ sessionId });

    return {
      conversations: conversation ? [conversation] : [],
      sessions: [session],
      turns,
      messageBlocks: turns.flatMap((turn) =>
        this.listMessageBlocks({ turnId: turn.turnId })
      ),
      toolCalls: turns.flatMap((turn) => this.listToolCalls({ turnId: turn.turnId })),
      terminalStreams: turns.flatMap((turn) =>
        this.listTerminalStreams({ turnId: turn.turnId })
      ),
      approvalRequests: turns.flatMap((turn) =>
        this.listApprovalRequests({ turnId: turn.turnId })
      ),
      participants: this.listParticipants({
        conversationId: session.conversationId,
        engineId: session.engineId
      }),
      sessionRelations: this.listSessionRelations({ sessionId })
    };
  }

  public getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  public listConversations(): Conversation[] {
    return sortByIsoAsc(
      this.conversations.values(),
      (conversation) => conversation.createdAt,
      (conversation) => conversation.conversationId
    );
  }

  public upsertConversation(conversation: Conversation | unknown): Conversation {
    const parsedConversation = parseConversation(conversation);
    this.conversations.set(parsedConversation.conversationId, parsedConversation);
    return parsedConversation;
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  public listSessions(options: ListSessionsOptions = {}): ChatSession[] {
    let sessions = [...this.sessions.values()];

    if (options.conversationId) {
      sessions = mapIdsToValues(
        this.sessionIdsByConversation.get(options.conversationId),
        (sessionId) => this.sessions.get(sessionId)
      );
    }

    if (options.engineId) {
      sessions = sessions.filter((session) => session.engineId === options.engineId);
    }

    if (!options.includeArchived) {
      sessions = sessions.filter((session) => !session.archivedAt);
    }

    return sortSessionsByUpdatedAtDesc(sessions);
  }

  public upsertSession(session: ChatSession | unknown): ChatSession {
    const parsedSession = parseChatSession(session);
    const existing = this.sessions.get(parsedSession.sessionId);
    if (existing && existing.conversationId !== parsedSession.conversationId) {
      removeIndexedValue(
        this.sessionIdsByConversation,
        existing.conversationId,
        existing.sessionId
      );
    }

    this.sessions.set(parsedSession.sessionId, parsedSession);
    addUniqueValue(
      this.sessionIdsByConversation,
      parsedSession.conversationId,
      parsedSession.sessionId
    );
    return parsedSession;
  }

  public deleteSession(sessionId: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return false;
    }
    this.sessions.delete(sessionId);
    removeIndexedValue(
      this.sessionIdsByConversation,
      existing.conversationId,
      existing.sessionId
    );
    return true;
  }

  public getTurn(turnId: string): Turn | undefined {
    return this.turns.get(turnId);
  }

  public listTurns(options: ListTurnsOptions = {}): Turn[] {
    const turns = options.sessionId
      ? mapIdsToValues(this.turnIdsBySession.get(options.sessionId), (turnId) =>
          this.turns.get(turnId)
        )
      : [...this.turns.values()];

    return sortByIsoAsc(turns, (turn) => turn.startedAt, (turn) => turn.turnId);
  }

  public upsertTurn(turn: Turn | unknown): Turn {
    const parsedTurn = parseTurn(turn);
    const existing = this.turns.get(parsedTurn.turnId);
    if (existing && existing.sessionId !== parsedTurn.sessionId) {
      removeIndexedValue(this.turnIdsBySession, existing.sessionId, existing.turnId);
    }

    this.turns.set(parsedTurn.turnId, parsedTurn);
    addUniqueValue(this.turnIdsBySession, parsedTurn.sessionId, parsedTurn.turnId);
    return parsedTurn;
  }

  public deleteTurn(turnId: string): boolean {
    const existing = this.turns.get(turnId);
    if (!existing) {
      return false;
    }
    this.turns.delete(turnId);
    removeIndexedValue(this.turnIdsBySession, existing.sessionId, existing.turnId);
    return true;
  }

  public getMessageBlock(blockId: string): MessageBlock | undefined {
    return this.messageBlocks.get(blockId);
  }

  public listMessageBlocks(options: ListMessageBlocksOptions = {}): MessageBlock[] {
    let blocks: MessageBlock[];

    if (options.messageId) {
      blocks = mapIdsToValues(
        this.messageBlockIdsByMessage.get(options.messageId),
        (blockId) => this.messageBlocks.get(blockId)
      );
    } else if (options.turnId) {
      blocks = mapIdsToValues(this.messageBlockIdsByTurn.get(options.turnId), (blockId) =>
        this.messageBlocks.get(blockId)
      );
    } else if (options.sessionId) {
      blocks = this.listTurns({ sessionId: options.sessionId }).flatMap((turn) =>
        this.listMessageBlocks({ turnId: turn.turnId })
      );
    } else {
      blocks = [...this.messageBlocks.values()];
    }

    return sortByIsoAsc(blocks, (block) => block.startedAt, (block) => block.blockId);
  }

  public upsertMessageBlock(block: MessageBlock | unknown): MessageBlock {
    const parsedBlock = parseMessageBlock(block);
    const existing = this.messageBlocks.get(parsedBlock.blockId);
    if (existing) {
      if (existing.turnId !== parsedBlock.turnId) {
        removeIndexedValue(this.messageBlockIdsByTurn, existing.turnId, existing.blockId);
      }
      if (existing.messageId !== parsedBlock.messageId) {
        removeIndexedValue(
          this.messageBlockIdsByMessage,
          existing.messageId,
          existing.blockId
        );
      }
    }

    this.messageBlocks.set(parsedBlock.blockId, parsedBlock);
    addUniqueValue(this.messageBlockIdsByTurn, parsedBlock.turnId, parsedBlock.blockId);
    addUniqueValue(
      this.messageBlockIdsByMessage,
      parsedBlock.messageId,
      parsedBlock.blockId
    );
    return parsedBlock;
  }

  public deleteMessageBlock(blockId: string): boolean {
    const existing = this.messageBlocks.get(blockId);
    if (!existing) {
      return false;
    }
    this.messageBlocks.delete(blockId);
    removeIndexedValue(this.messageBlockIdsByTurn, existing.turnId, existing.blockId);
    removeIndexedValue(
      this.messageBlockIdsByMessage,
      existing.messageId,
      existing.blockId
    );
    return true;
  }

  public getToolCall(toolCallId: string): ToolCall | undefined {
    return this.toolCalls.get(toolCallId);
  }

  public listToolCalls(options: ListToolCallsOptions = {}): ToolCall[] {
    const toolCalls =
      options.turnId !== undefined
        ? mapIdsToValues(this.toolCallIdsByTurn.get(options.turnId), (toolCallId) =>
            this.toolCalls.get(toolCallId)
          )
        : options.sessionId !== undefined
          ? this.listTurns({ sessionId: options.sessionId }).flatMap((turn) =>
              this.listToolCalls({ turnId: turn.turnId })
            )
          : [...this.toolCalls.values()];

    return sortByIsoAsc(
      toolCalls,
      (toolCall) => toolCall.startedAt,
      (toolCall) => toolCall.toolCallId
    );
  }

  public upsertToolCall(toolCall: ToolCall | unknown): ToolCall {
    const parsedToolCall = parseToolCall(toolCall);
    const existing = this.toolCalls.get(parsedToolCall.toolCallId);
    if (existing && existing.turnId !== parsedToolCall.turnId) {
      removeIndexedValue(this.toolCallIdsByTurn, existing.turnId, existing.toolCallId);
    }

    this.toolCalls.set(parsedToolCall.toolCallId, parsedToolCall);
    addUniqueValue(
      this.toolCallIdsByTurn,
      parsedToolCall.turnId,
      parsedToolCall.toolCallId
    );
    return parsedToolCall;
  }

  public deleteToolCall(toolCallId: string): boolean {
    const existing = this.toolCalls.get(toolCallId);
    if (!existing) {
      return false;
    }
    this.toolCalls.delete(toolCallId);
    removeIndexedValue(this.toolCallIdsByTurn, existing.turnId, existing.toolCallId);
    return true;
  }

  public getTerminalStream(terminalId: string): TerminalStream | undefined {
    return this.terminalStreams.get(terminalId);
  }

  public listTerminalStreams(options: ListTerminalStreamsOptions = {}): TerminalStream[] {
    const streams =
      options.turnId !== undefined
        ? mapIdsToValues(this.terminalIdsByTurn.get(options.turnId), (terminalId) =>
            this.terminalStreams.get(terminalId)
          )
        : options.sessionId !== undefined
          ? this.listTurns({ sessionId: options.sessionId }).flatMap((turn) =>
              this.listTerminalStreams({ turnId: turn.turnId })
            )
          : [...this.terminalStreams.values()];

    return sortByIsoAsc(
      streams,
      (stream) => stream.startedAt,
      (stream) => stream.terminalId
    );
  }

  public upsertTerminalStream(terminalStream: TerminalStream | unknown): TerminalStream {
    const parsedStream = parseTerminalStream(terminalStream);
    const existing = this.terminalStreams.get(parsedStream.terminalId);
    if (existing && existing.turnId !== parsedStream.turnId) {
      removeIndexedValue(this.terminalIdsByTurn, existing.turnId, existing.terminalId);
    }

    this.terminalStreams.set(parsedStream.terminalId, parsedStream);
    addUniqueValue(this.terminalIdsByTurn, parsedStream.turnId, parsedStream.terminalId);
    return parsedStream;
  }

  public deleteTerminalStream(terminalId: string): boolean {
    const existing = this.terminalStreams.get(terminalId);
    if (!existing) {
      return false;
    }
    this.terminalStreams.delete(terminalId);
    removeIndexedValue(this.terminalIdsByTurn, existing.turnId, existing.terminalId);
    return true;
  }

  public getApprovalRequest(requestId: string): ApprovalRequest | undefined {
    return this.approvalRequests.get(requestId);
  }

  public listApprovalRequests(options: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
    const approvals =
      options.turnId !== undefined
        ? mapIdsToValues(
            this.approvalRequestIdsByTurn.get(options.turnId),
            (requestId) => this.approvalRequests.get(requestId)
          )
        : options.sessionId !== undefined
          ? this.listTurns({ sessionId: options.sessionId }).flatMap((turn) =>
              this.listApprovalRequests({ turnId: turn.turnId })
            )
          : [...this.approvalRequests.values()];

    return sortByIsoAsc(
      approvals,
      (approval) => approval.requestedAt,
      (approval) => approval.requestId
    );
  }

  public upsertApprovalRequest(
    approvalRequest: ApprovalRequest | unknown
  ): ApprovalRequest {
    const parsedRequest = parseApprovalRequest(approvalRequest);
    const existing = this.approvalRequests.get(parsedRequest.requestId);
    if (existing && existing.turnId !== parsedRequest.turnId) {
      removeIndexedValue(
        this.approvalRequestIdsByTurn,
        existing.turnId,
        existing.requestId
      );
    }

    this.approvalRequests.set(parsedRequest.requestId, parsedRequest);
    addUniqueValue(
      this.approvalRequestIdsByTurn,
      parsedRequest.turnId,
      parsedRequest.requestId
    );
    return parsedRequest;
  }

  public deleteApprovalRequest(requestId: string): boolean {
    const existing = this.approvalRequests.get(requestId);
    if (!existing) {
      return false;
    }
    this.approvalRequests.delete(requestId);
    removeIndexedValue(
      this.approvalRequestIdsByTurn,
      existing.turnId,
      existing.requestId
    );
    return true;
  }

  public getParticipant(participantId: string): AgentParticipant | undefined {
    return this.participants.get(participantId);
  }

  public listParticipants(options: ListParticipantsOptions = {}): AgentParticipant[] {
    let participants = options.conversationId
      ? mapIdsToValues(
          this.participantIdsByConversation.get(options.conversationId),
          (participantId) => this.participants.get(participantId)
        )
      : [...this.participants.values()];

    if (options.engineId) {
      participants = participants.filter(
        (participant) => participant.engineId === options.engineId
      );
    }

    return [...participants].sort((left, right) =>
      left.participantId.localeCompare(right.participantId)
    );
  }

  public upsertParticipant(participant: AgentParticipant | unknown): AgentParticipant {
    const parsedParticipant = parseAgentParticipant(participant);
    const existing = this.participants.get(parsedParticipant.participantId);
    if (
      existing &&
      existing.conversationId !== parsedParticipant.conversationId
    ) {
      removeIndexedValue(
        this.participantIdsByConversation,
        existing.conversationId,
        existing.participantId
      );
    }

    this.participants.set(parsedParticipant.participantId, parsedParticipant);
    addUniqueValue(
      this.participantIdsByConversation,
      parsedParticipant.conversationId,
      parsedParticipant.participantId
    );
    return parsedParticipant;
  }

  public deleteParticipant(participantId: string): boolean {
    const existing = this.participants.get(participantId);
    if (!existing) {
      return false;
    }
    this.participants.delete(participantId);
    removeIndexedValue(
      this.participantIdsByConversation,
      existing.conversationId,
      existing.participantId
    );
    return true;
  }

  public getSessionRelation(relationId: string): SessionRelation | undefined {
    return this.sessionRelations.get(relationId);
  }

  public listSessionRelations(
    options: ListSessionRelationsOptions = {}
  ): SessionRelation[] {
    let relations = [...this.sessionRelations.values()];

    if (options.sessionId) {
      relations = relations.filter(
        (relation) =>
          relation.parentSessionId === options.sessionId ||
          relation.childSessionId === options.sessionId
      );
    }

    if (options.parentSessionId) {
      relations = relations.filter(
        (relation) => relation.parentSessionId === options.parentSessionId
      );
    }

    if (options.childSessionId) {
      relations = relations.filter(
        (relation) => relation.childSessionId === options.childSessionId
      );
    }

    return sortByIsoAsc(
      relations,
      (relation) => relation.createdAt,
      (relation) => relation.relationId
    );
  }

  public upsertSessionRelation(relation: SessionRelation | unknown): SessionRelation {
    const parsedRelation = parseSessionRelation(relation);
    const existing = this.sessionRelations.get(parsedRelation.relationId);
    if (existing) {
      if (existing.childSessionId !== parsedRelation.childSessionId) {
        this.parentSessionIdByChild.delete(existing.childSessionId);
      }
      if (existing.parentSessionId !== parsedRelation.parentSessionId) {
        removeIndexedValue(
          this.childSessionIdsByParent,
          existing.parentSessionId,
          existing.childSessionId
        );
      }
    }

    this.sessionRelations.set(parsedRelation.relationId, parsedRelation);
    this.parentSessionIdByChild.set(
      parsedRelation.childSessionId,
      parsedRelation.parentSessionId
    );
    addUniqueValue(
      this.childSessionIdsByParent,
      parsedRelation.parentSessionId,
      parsedRelation.childSessionId
    );
    return parsedRelation;
  }

  public deleteSessionRelation(relationId: string): boolean {
    const existing = this.sessionRelations.get(relationId);
    if (!existing) {
      return false;
    }
    this.sessionRelations.delete(relationId);
    if (this.parentSessionIdByChild.get(existing.childSessionId) === existing.parentSessionId) {
      this.parentSessionIdByChild.delete(existing.childSessionId);
    }
    removeIndexedValue(
      this.childSessionIdsByParent,
      existing.parentSessionId,
      existing.childSessionId
    );
    return true;
  }

  public getSessionChildren(sessionId: string): string[] {
    return [...(this.childSessionIdsByParent.get(sessionId) ?? [])];
  }

  public getSessionParent(sessionId: string): string | undefined {
    return this.parentSessionIdByChild.get(sessionId);
  }

  public resolveConversationIdBySessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.conversationId;
  }

  public deleteSessionCascade(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    for (const relation of this.listSessionRelations({ sessionId })) {
      this.deleteSessionRelation(relation.relationId);
    }

    for (const turn of this.listTurns({ sessionId })) {
      for (const block of this.listMessageBlocks({ turnId: turn.turnId })) {
        this.deleteMessageBlock(block.blockId);
      }
      for (const toolCall of this.listToolCalls({ turnId: turn.turnId })) {
        this.deleteToolCall(toolCall.toolCallId);
      }
      for (const terminalStream of this.listTerminalStreams({ turnId: turn.turnId })) {
        this.deleteTerminalStream(terminalStream.terminalId);
      }
      for (const approvalRequest of this.listApprovalRequests({ turnId: turn.turnId })) {
        this.deleteApprovalRequest(approvalRequest.requestId);
      }
      this.deleteTurn(turn.turnId);
    }

    return this.deleteSession(sessionId);
  }
}
