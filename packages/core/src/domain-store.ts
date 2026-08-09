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
import {
  parseAgentParticipant,
  parseApprovalRequest,
  parseChatSession,
  parseConversation,
  parseDomainSnapshot,
  parseMessageBlock,
  parseRuntimeInteraction,
  parseSessionRelation,
  parseTerminalStream,
  parseThreadGoal,
  parseToolCall,
  parseTurn
} from "@another-workbench/shared";
import { createEmptyDomainSnapshot } from "./domain.js";

export type DomainStoreOptions = {
  snapshot?: DomainSnapshot;
};

export type DomainSnapshotMergeScope = {
  conversationId?: string;
  sessionId?: string;
};

export type DomainSnapshotMergeOptions = {
  scope?: DomainSnapshotMergeScope;
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

export type ListRuntimeInteractionsOptions = {
  sessionId?: string;
  turnId?: string;
};

export type ListThreadGoalsOptions = {
  sessionId?: string;
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

export type DomainStoreRelationErrorCode =
  | "duplicate_structural_parent"
  | "cycle"
  | "conversation_mismatch";

export class DomainStoreRelationError extends Error {
  public constructor(
    public readonly code: DomainStoreRelationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DomainStoreRelationError";
  }
}

type StoredConversation = Omit<Conversation, "participantEngineIds" | "sessionIds">;
type StoredTurn = Omit<
  Turn,
  | "messageIds"
  | "toolCallIds"
  | "terminalIds"
  | "approvalRequestIds"
  | "interactionRequestIds"
>;
type StoredParticipant = Omit<AgentParticipant, "activeSessionIds">;

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

const sortThreadGoalsByUpdatedAtAsc = (goals: Iterable<ThreadGoal>): ThreadGoal[] =>
  [...goals].sort((left, right) => {
    const byUpdatedAt = left.updatedAt - right.updatedAt;
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });

const cloneConversation = (conversation: Conversation): Conversation =>
  parseConversation(conversation);

const cloneSession = (session: ChatSession): ChatSession => parseChatSession(session);

const cloneTurn = (turn: Turn): Turn => parseTurn(turn);

const cloneMessageBlock = (block: MessageBlock): MessageBlock =>
  parseMessageBlock(block);

const cloneToolCall = (toolCall: ToolCall): ToolCall => parseToolCall(toolCall);

const cloneTerminalStream = (stream: TerminalStream): TerminalStream =>
  parseTerminalStream(stream);

const cloneApprovalRequest = (request: ApprovalRequest): ApprovalRequest =>
  parseApprovalRequest(request);

const cloneRuntimeInteraction = (
  interaction: RuntimeInteraction
): RuntimeInteraction => parseRuntimeInteraction(interaction);

const cloneParticipant = (participant: AgentParticipant): AgentParticipant =>
  parseAgentParticipant(participant);

const cloneThreadGoal = (goal: ThreadGoal): ThreadGoal => parseThreadGoal(goal);

const cloneSessionRelation = (relation: SessionRelation): SessionRelation =>
  parseSessionRelation(relation);

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

const mergeIndexedValues = (
  map: Map<string, string[]>,
  key: string,
  values: readonly string[]
): void => {
  for (const value of values) {
    addUniqueValue(map, key, value);
  }
};

const setIndexedValues = (
  map: Map<string, string[]>,
  key: string,
  values: readonly string[]
): void => {
  map.delete(key);
  mergeIndexedValues(map, key, values);
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

const mergeUniqueStrings = (
  left: readonly string[] = [],
  right: readonly string[] = []
): string[] => {
  const merged = [...left];
  for (const value of right) {
    if (!merged.includes(value)) {
      merged.push(value);
    }
  }
  return merged;
};

const mergeRecords = (
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (!left && !right) {
    return undefined;
  }
  return {
    ...(left ?? {}),
    ...(right ?? {})
  };
};

export class DomainStore {
  private conversations = new Map<string, StoredConversation>();
  private sessions = new Map<string, ChatSession>();
  private turns = new Map<string, StoredTurn>();
  private messageBlocks = new Map<string, MessageBlock>();
  private toolCalls = new Map<string, ToolCall>();
  private terminalStreams = new Map<string, TerminalStream>();
  private approvalRequests = new Map<string, ApprovalRequest>();
  private runtimeInteractions = new Map<string, RuntimeInteraction>();
  private participants = new Map<string, StoredParticipant>();
  private threadGoals = new Map<string, ThreadGoal>();
  private sessionRelations = new Map<string, SessionRelation>();

  private sessionIdsByConversation = new Map<string, string[]>();
  private participantEngineIdsByConversation = new Map<string, string[]>();
  private turnIdsBySession = new Map<string, string[]>();
  private messageIdsByTurn = new Map<string, string[]>();
  private messageBlockIdsByTurn = new Map<string, string[]>();
  private messageBlockIdsByMessage = new Map<string, string[]>();
  private toolCallIdsByTurn = new Map<string, string[]>();
  private terminalIdsByTurn = new Map<string, string[]>();
  private approvalRequestIdsByTurn = new Map<string, string[]>();
  private interactionRequestIdsByTurn = new Map<string, string[]>();
  private participantIdsByConversation = new Map<string, string[]>();
  private activeSessionIdsByParticipant = new Map<string, string[]>();
  private parentSessionIdByChild = new Map<string, string>();
  private childSessionIdsByParent = new Map<string, string[]>();

  public constructor(options: DomainStoreOptions = {}) {
    if (options.snapshot) {
      this.replaceSnapshot(options.snapshot);
    }
  }

  public static fromSnapshot(snapshot: DomainSnapshot | unknown): DomainStore {
    const store = new DomainStore();
    store.applyParsedSnapshot(parseDomainSnapshot(snapshot), {
      merge: false
    });
    return store;
  }

  public clear(): void {
    this.conversations.clear();
    this.sessions.clear();
    this.turns.clear();
    this.messageBlocks.clear();
    this.toolCalls.clear();
    this.terminalStreams.clear();
    this.approvalRequests.clear();
    this.runtimeInteractions.clear();
    this.participants.clear();
    this.threadGoals.clear();
    this.sessionRelations.clear();

    this.sessionIdsByConversation.clear();
    this.participantEngineIdsByConversation.clear();
    this.turnIdsBySession.clear();
    this.messageIdsByTurn.clear();
    this.messageBlockIdsByTurn.clear();
    this.messageBlockIdsByMessage.clear();
    this.toolCallIdsByTurn.clear();
    this.terminalIdsByTurn.clear();
    this.approvalRequestIdsByTurn.clear();
    this.interactionRequestIdsByTurn.clear();
    this.participantIdsByConversation.clear();
    this.activeSessionIdsByParticipant.clear();
    this.parentSessionIdByChild.clear();
    this.childSessionIdsByParent.clear();
  }

  public replaceSnapshot(snapshot: DomainSnapshot | unknown): DomainSnapshot {
    const staged = DomainStore.fromSnapshot(snapshot);
    this.swapFrom(staged);
    return this.getSnapshot();
  }

  public mergeSnapshot(
    snapshot: DomainSnapshot | unknown,
    options: DomainSnapshotMergeOptions = {}
  ): DomainSnapshot {
    const parsedSnapshot = parseDomainSnapshot(snapshot);
    const staged = DomainStore.fromSnapshot(this.getSnapshot());
    staged.assertSnapshotWithinMergeScope(parsedSnapshot, options.scope);
    staged.applyParsedSnapshot(parsedSnapshot, {
      merge: true
    });
    this.swapFrom(staged);
    return this.getSnapshot();
  }

  public replaceSessionWindowSnapshot(
    sessionId: string,
    snapshot: DomainSnapshot | unknown
  ): DomainSnapshot {
    const parsedSnapshot = parseDomainSnapshot(snapshot);
    const staged = DomainStore.fromSnapshot(this.getSnapshot());
    staged.assertSnapshotWithinMergeScope(parsedSnapshot, { sessionId });
    staged.deleteSessionWindowCoverage(sessionId, parsedSnapshot);
    staged.applyParsedSnapshot(parsedSnapshot, {
      merge: true
    });
    this.swapFrom(staged);
    return this.getSnapshot();
  }

  private applyParsedSnapshot(
    parsedSnapshot: DomainSnapshot,
    options: {
      merge: boolean;
    }
  ): void {
    for (const conversation of parsedSnapshot.conversations) {
      if (options.merge) {
        this.mergeConversation(conversation);
      } else {
        this.upsertConversation(conversation);
      }
    }
    for (const session of parsedSnapshot.sessions) {
      this.upsertSession(session);
    }
    for (const turn of parsedSnapshot.turns) {
      if (options.merge) {
        this.mergeTurn(turn);
      } else {
        this.upsertTurn(turn);
      }
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
    for (const interaction of parsedSnapshot.runtimeInteractions ?? []) {
      this.upsertRuntimeInteraction(interaction);
    }
    for (const participant of parsedSnapshot.participants) {
      if (options.merge) {
        this.mergeParticipant(participant);
      } else {
        this.upsertParticipant(participant);
      }
    }
    for (const goal of parsedSnapshot.threadGoals) {
      this.upsertThreadGoal(goal);
    }
    for (const relation of parsedSnapshot.sessionRelations) {
      this.upsertSessionRelation(relation);
    }
  }

  private swapFrom(staged: DomainStore): void {
    this.conversations = staged.conversations;
    this.sessions = staged.sessions;
    this.turns = staged.turns;
    this.messageBlocks = staged.messageBlocks;
    this.toolCalls = staged.toolCalls;
    this.terminalStreams = staged.terminalStreams;
    this.approvalRequests = staged.approvalRequests;
    this.runtimeInteractions = staged.runtimeInteractions;
    this.participants = staged.participants;
    this.threadGoals = staged.threadGoals;
    this.sessionRelations = staged.sessionRelations;

    this.sessionIdsByConversation = staged.sessionIdsByConversation;
    this.participantEngineIdsByConversation =
      staged.participantEngineIdsByConversation;
    this.turnIdsBySession = staged.turnIdsBySession;
    this.messageIdsByTurn = staged.messageIdsByTurn;
    this.messageBlockIdsByTurn = staged.messageBlockIdsByTurn;
    this.messageBlockIdsByMessage = staged.messageBlockIdsByMessage;
    this.toolCallIdsByTurn = staged.toolCallIdsByTurn;
    this.terminalIdsByTurn = staged.terminalIdsByTurn;
    this.approvalRequestIdsByTurn = staged.approvalRequestIdsByTurn;
    this.interactionRequestIdsByTurn = staged.interactionRequestIdsByTurn;
    this.participantIdsByConversation = staged.participantIdsByConversation;
    this.activeSessionIdsByParticipant = staged.activeSessionIdsByParticipant;
    this.parentSessionIdByChild = staged.parentSessionIdByChild;
    this.childSessionIdsByParent = staged.childSessionIdsByParent;
  }

  private mergeConversation(conversation: Conversation): Conversation {
    const parsedConversation = parseConversation(conversation);
    const existing = this.getConversation(parsedConversation.conversationId);
    if (!existing) {
      return this.upsertConversation(parsedConversation);
    }
    return this.upsertConversation({
      ...existing,
      ...parsedConversation,
      participantEngineIds: mergeUniqueStrings(
        existing.participantEngineIds,
        parsedConversation.participantEngineIds
      ),
      sessionIds: mergeUniqueStrings(existing.sessionIds, parsedConversation.sessionIds),
      metadata: mergeRecords(existing.metadata, parsedConversation.metadata)
    });
  }

  private mergeParticipant(participant: AgentParticipant): AgentParticipant {
    const parsedParticipant = parseAgentParticipant(participant);
    const existing = this.getParticipant(parsedParticipant.participantId);
    if (!existing) {
      return this.upsertParticipant(parsedParticipant);
    }
    return this.upsertParticipant({
      ...existing,
      ...parsedParticipant,
      capabilities: mergeUniqueStrings(
        existing.capabilities,
        parsedParticipant.capabilities
      ),
      activeSessionIds: mergeUniqueStrings(
        existing.activeSessionIds,
        parsedParticipant.activeSessionIds
      ),
      metadata: mergeRecords(existing.metadata, parsedParticipant.metadata)
    });
  }

  private mergeTurn(turn: Turn): Turn {
    const parsedTurn = parseTurn(turn);
    const existing = this.getTurn(parsedTurn.turnId);
    if (!existing) {
      return this.upsertTurn(parsedTurn);
    }
    return this.upsertTurn({
      ...existing,
      ...parsedTurn,
      messageIds: mergeUniqueStrings(existing.messageIds, parsedTurn.messageIds),
      toolCallIds: mergeUniqueStrings(
        existing.toolCallIds,
        parsedTurn.toolCallIds
      ),
      terminalIds: mergeUniqueStrings(existing.terminalIds, parsedTurn.terminalIds),
      approvalRequestIds: mergeUniqueStrings(
        existing.approvalRequestIds,
        parsedTurn.approvalRequestIds
      ),
      interactionRequestIds: mergeUniqueStrings(
        existing.interactionRequestIds,
        parsedTurn.interactionRequestIds
      )
    });
  }

  private assertSnapshotWithinMergeScope(
    snapshot: DomainSnapshot,
    scope: DomainSnapshotMergeScope | undefined
  ): void {
    if (!scope?.conversationId && !scope?.sessionId) {
      return;
    }

    const sessionConversationIds = new Map<string, string>();
    for (const session of this.sessions.values()) {
      sessionConversationIds.set(session.sessionId, session.conversationId);
    }
    for (const session of snapshot.sessions) {
      sessionConversationIds.set(session.sessionId, session.conversationId);
    }
    const scopedSessionConversationId = scope?.sessionId
      ? sessionConversationIds.get(scope.sessionId)
      : undefined;

    const assertSessionId = (sessionId: string, label: string): void => {
      if (scope?.sessionId && sessionId !== scope.sessionId) {
        throw new Error(
          `${label} belongs to session ${sessionId}, outside merge scope ${scope.sessionId}.`
        );
      }
      if (scope?.conversationId) {
        const conversationId = sessionConversationIds.get(sessionId);
        if (conversationId && conversationId !== scope.conversationId) {
          throw new Error(
            `${label} belongs to conversation ${conversationId}, outside merge scope ${scope.conversationId}.`
          );
        }
      }
    };
    const assertConversationId = (conversationId: string, label: string): void => {
      if (scope?.conversationId && conversationId !== scope.conversationId) {
        throw new Error(
          `${label} belongs to conversation ${conversationId}, outside merge scope ${scope.conversationId}.`
        );
      }
      if (
        scopedSessionConversationId &&
        conversationId !== scopedSessionConversationId
      ) {
        throw new Error(
          `${label} belongs to conversation ${conversationId}, outside merge scope ${scopedSessionConversationId}.`
        );
      }
    };

    for (const conversation of snapshot.conversations) {
      assertConversationId(conversation.conversationId, "Conversation");
    }
    for (const session of snapshot.sessions) {
      assertSessionId(session.sessionId, "Session");
      assertConversationId(session.conversationId, "Session");
    }
    for (const turn of snapshot.turns) {
      assertSessionId(turn.sessionId, "Turn");
    }
    for (const block of snapshot.messageBlocks) {
      assertSessionId(block.sessionId, "Message block");
    }
    for (const toolCall of snapshot.toolCalls) {
      assertSessionId(toolCall.sessionId, "Tool call");
    }
    for (const terminalStream of snapshot.terminalStreams) {
      assertSessionId(terminalStream.sessionId, "Terminal stream");
    }
    for (const approvalRequest of snapshot.approvalRequests) {
      assertSessionId(approvalRequest.sessionId, "Approval request");
    }
    for (const interaction of snapshot.runtimeInteractions) {
      assertSessionId(interaction.sessionId, "Runtime interaction");
    }
    for (const participant of snapshot.participants) {
      assertConversationId(participant.conversationId, "Participant");
    }
    for (const goal of snapshot.threadGoals) {
      assertSessionId(goal.sessionId, "Thread goal");
    }
    for (const relation of snapshot.sessionRelations) {
      if (
        scope?.sessionId &&
        relation.parentSessionId !== scope.sessionId &&
        relation.childSessionId !== scope.sessionId
      ) {
        throw new Error(
          `Session relation ${relation.relationId} is outside merge scope ${scope.sessionId}.`
        );
      }
      if (scope?.conversationId) {
        assertSessionId(relation.parentSessionId, "Session relation parent");
        assertSessionId(relation.childSessionId, "Session relation child");
      }
    }
  }

  private deleteSessionWindowCoverage(
    sessionId: string,
    snapshot: DomainSnapshot
  ): void {
    const coveredTurns = snapshot.turns.filter((turn) => turn.sessionId === sessionId);
    if (coveredTurns.length === 0) {
      return;
    }

    const coveredTurnIds = new Set(coveredTurns.map((turn) => turn.turnId));
    const coveredMessageIds = new Set(
      coveredTurns.flatMap((turn) => turn.messageIds)
    );
    const coveredToolCallIds = new Set(
      coveredTurns.flatMap((turn) => turn.toolCallIds)
    );
    const coveredTerminalIds = new Set(
      coveredTurns.flatMap((turn) => turn.terminalIds)
    );
    const coveredApprovalRequestIds = new Set(
      coveredTurns.flatMap((turn) => turn.approvalRequestIds)
    );
    const coveredInteractionRequestIds = new Set(
      coveredTurns.flatMap((turn) => turn.interactionRequestIds ?? [])
    );

    for (const block of this.listMessageBlocks({ sessionId })) {
      if (
        coveredTurnIds.has(block.turnId) ||
        coveredMessageIds.has(block.messageId)
      ) {
        this.deleteMessageBlock(block.blockId);
      }
    }
    for (const toolCall of this.listToolCalls({ sessionId })) {
      if (
        coveredTurnIds.has(toolCall.turnId) ||
        coveredToolCallIds.has(toolCall.toolCallId)
      ) {
        this.deleteToolCall(toolCall.toolCallId);
      }
    }
    for (const terminal of this.listTerminalStreams({ sessionId })) {
      if (
        coveredTurnIds.has(terminal.turnId) ||
        coveredTerminalIds.has(terminal.terminalId)
      ) {
        this.deleteTerminalStream(terminal.terminalId);
      }
    }
    for (const approval of this.listApprovalRequests({ sessionId })) {
      if (
        coveredTurnIds.has(approval.turnId) ||
        coveredApprovalRequestIds.has(approval.requestId)
      ) {
        this.deleteApprovalRequest(approval.requestId);
      }
    }
    for (const interaction of this.listRuntimeInteractions({ sessionId })) {
      if (
        coveredTurnIds.has(interaction.turnId ?? "") ||
        coveredInteractionRequestIds.has(interaction.requestId)
      ) {
        this.deleteRuntimeInteraction(interaction.requestId);
      }
    }
    for (const turn of coveredTurns) {
      this.deleteTurn(turn.turnId);
    }
  }

  private materializeConversation(conversation: StoredConversation): Conversation {
    return parseConversation({
      ...conversation,
      participantEngineIds: [
        ...(this.participantEngineIdsByConversation.get(conversation.conversationId) ??
          [])
      ],
      sessionIds: [
        ...(this.sessionIdsByConversation.get(conversation.conversationId) ?? [])
      ]
    });
  }

  private materializeTurn(turn: StoredTurn): Turn {
    return parseTurn({
      ...turn,
      messageIds: [...(this.messageIdsByTurn.get(turn.turnId) ?? [])],
      toolCallIds: [...(this.toolCallIdsByTurn.get(turn.turnId) ?? [])],
      terminalIds: [...(this.terminalIdsByTurn.get(turn.turnId) ?? [])],
      approvalRequestIds: [
        ...(this.approvalRequestIdsByTurn.get(turn.turnId) ?? [])
      ],
      interactionRequestIds: [
        ...(this.interactionRequestIdsByTurn.get(turn.turnId) ?? [])
      ]
    });
  }

  private materializeParticipant(participant: StoredParticipant): AgentParticipant {
    return parseAgentParticipant({
      ...participant,
      activeSessionIds: [
        ...(this.activeSessionIdsByParticipant.get(participant.participantId) ?? [])
      ]
    });
  }

  public getSnapshot(): DomainSnapshot {
    return {
      conversations: sortByIsoAsc(
        this.conversations.values(),
        (conversation) => conversation.createdAt,
        (conversation) => conversation.conversationId
      ).map((conversation) => this.materializeConversation(conversation)),
      sessions: this.listSessions({ includeArchived: true }),
      turns: sortByIsoAsc(
        this.turns.values(),
        (turn) => turn.startedAt,
        (turn) => turn.turnId
      ).map((turn) => this.materializeTurn(turn)),
      messageBlocks: sortByIsoAsc(
        this.messageBlocks.values(),
        (block) => block.startedAt,
        (block) => block.blockId
      ).map(cloneMessageBlock),
      toolCalls: sortByIsoAsc(
        this.toolCalls.values(),
        (toolCall) => toolCall.startedAt,
        (toolCall) => toolCall.toolCallId
      ).map(cloneToolCall),
      terminalStreams: sortByIsoAsc(
        this.terminalStreams.values(),
        (stream) => stream.startedAt,
        (stream) => stream.terminalId
      ).map(cloneTerminalStream),
      approvalRequests: sortByIsoAsc(
        this.approvalRequests.values(),
        (approval) => approval.requestedAt,
        (approval) => approval.requestId
      ).map(cloneApprovalRequest),
      runtimeInteractions: sortByIsoAsc(
        this.runtimeInteractions.values(),
        (interaction) => interaction.requestedAt,
        (interaction) => interaction.requestId
      ).map(cloneRuntimeInteraction),
      participants: [...this.participants.values()].sort((left, right) =>
        left.participantId.localeCompare(right.participantId)
      ).map((participant) => this.materializeParticipant(participant)),
      threadGoals: this.listThreadGoals(),
      sessionRelations: sortByIsoAsc(
        this.sessionRelations.values(),
        (relation) => relation.createdAt,
        (relation) => relation.relationId
      ).map(cloneSessionRelation)
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
      runtimeInteractions: sessions.flatMap((session) =>
        this.listRuntimeInteractions({ sessionId: session.sessionId })
      ),
      participants: this.listParticipants({ conversationId }),
      threadGoals: sessions.flatMap((session) =>
        this.listThreadGoals({ sessionId: session.sessionId })
      ),
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
      runtimeInteractions: this.listRuntimeInteractions({ sessionId }),
      participants: this.listParticipants({
        conversationId: session.conversationId,
        engineId: session.engineId
      }),
      threadGoals: this.listThreadGoals({ sessionId }),
      sessionRelations: this.listSessionRelations({ sessionId })
    };
  }

  public getConversation(conversationId: string): Conversation | undefined {
    const conversation = this.conversations.get(conversationId);
    return conversation ? this.materializeConversation(conversation) : undefined;
  }

  public listConversations(): Conversation[] {
    return sortByIsoAsc(
      this.conversations.values(),
      (conversation) => conversation.createdAt,
      (conversation) => conversation.conversationId
    ).map((conversation) => this.materializeConversation(conversation));
  }

  public upsertConversation(conversation: Conversation | unknown): Conversation {
    const parsedConversation = parseConversation(conversation);
    const {
      participantEngineIds,
      sessionIds,
      ...storedConversation
    } = parsedConversation;
    this.conversations.set(
      parsedConversation.conversationId,
      storedConversation
    );
    setIndexedValues(
      this.participantEngineIdsByConversation,
      parsedConversation.conversationId,
      participantEngineIds
    );
    setIndexedValues(
      this.sessionIdsByConversation,
      parsedConversation.conversationId,
      sessionIds
    );
    return this.materializeConversation(storedConversation);
  }

  public getSession(sessionId: string): ChatSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
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

    return sortSessionsByUpdatedAtDesc(sessions).map(cloneSession);
  }

  public upsertSession(session: ChatSession | unknown): ChatSession {
    const parsedSession = parseChatSession(session);
    this.validateSessionConversation(parsedSession);
    const existing = this.sessions.get(parsedSession.sessionId);
    if (existing && existing.conversationId !== parsedSession.conversationId) {
      removeIndexedValue(
        this.sessionIdsByConversation,
        existing.conversationId,
        existing.sessionId
      );
    }
    if (
      existing &&
      (existing.conversationId !== parsedSession.conversationId ||
        existing.engineId !== parsedSession.engineId)
    ) {
      this.removeParticipantEngineIfUnused({
        conversationId: existing.conversationId,
        engineId: existing.engineId,
        excludingSessionId: existing.sessionId
      });
    }
    if (existing) {
      this.removeActiveSessionFromParticipants(existing);
    }
    this.sessions.set(parsedSession.sessionId, parsedSession);
    addUniqueValue(
      this.sessionIdsByConversation,
      parsedSession.conversationId,
      parsedSession.sessionId
    );
    addUniqueValue(
      this.participantEngineIdsByConversation,
      parsedSession.conversationId,
      parsedSession.engineId
    );
    if (!parsedSession.archivedAt) {
      this.addActiveSessionToParticipants(parsedSession);
    } else {
      this.removeActiveSessionFromParticipants(parsedSession);
    }
    return cloneSession(parsedSession);
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
    this.removeActiveSessionFromParticipants(existing);
    this.removeParticipantEngineIfUnused({
      conversationId: existing.conversationId,
      engineId: existing.engineId,
      excludingSessionId: existing.sessionId
    });
    return true;
  }

  public getTurn(turnId: string): Turn | undefined {
    const turn = this.turns.get(turnId);
    return turn ? this.materializeTurn(turn) : undefined;
  }

  public listTurns(options: ListTurnsOptions = {}): Turn[] {
    const turns = options.sessionId
      ? mapIdsToValues(this.turnIdsBySession.get(options.sessionId), (turnId) =>
          this.turns.get(turnId)
        )
      : [...this.turns.values()];

    return sortByIsoAsc(turns, (turn) => turn.startedAt, (turn) => turn.turnId).map(
      (turn) => this.materializeTurn(turn)
    );
  }

  public upsertTurn(turn: Turn | unknown): Turn {
    const parsedTurn = parseTurn(turn);
    const existing = this.turns.get(parsedTurn.turnId);
    if (existing && existing.sessionId !== parsedTurn.sessionId) {
      removeIndexedValue(this.turnIdsBySession, existing.sessionId, existing.turnId);
    }

    const {
      messageIds,
      toolCallIds,
      terminalIds,
      approvalRequestIds,
      interactionRequestIds,
      ...storedTurn
    } = parsedTurn;

    this.turns.set(parsedTurn.turnId, storedTurn);
    addUniqueValue(this.turnIdsBySession, parsedTurn.sessionId, parsedTurn.turnId);
    setIndexedValues(this.messageIdsByTurn, parsedTurn.turnId, messageIds);
    setIndexedValues(this.toolCallIdsByTurn, parsedTurn.turnId, toolCallIds);
    setIndexedValues(this.terminalIdsByTurn, parsedTurn.turnId, terminalIds);
    setIndexedValues(
      this.approvalRequestIdsByTurn,
      parsedTurn.turnId,
      approvalRequestIds
    );
    setIndexedValues(
      this.interactionRequestIdsByTurn,
      parsedTurn.turnId,
      interactionRequestIds
    );
    return this.materializeTurn(storedTurn);
  }

  public deleteTurn(turnId: string): boolean {
    const existing = this.turns.get(turnId);
    if (!existing) {
      return false;
    }
    this.turns.delete(turnId);
    removeIndexedValue(this.turnIdsBySession, existing.sessionId, existing.turnId);
    this.messageIdsByTurn.delete(turnId);
    this.toolCallIdsByTurn.delete(turnId);
    this.terminalIdsByTurn.delete(turnId);
    this.approvalRequestIdsByTurn.delete(turnId);
    this.interactionRequestIdsByTurn.delete(turnId);
    return true;
  }

  public getMessageBlock(blockId: string): MessageBlock | undefined {
    const block = this.messageBlocks.get(blockId);
    return block ? cloneMessageBlock(block) : undefined;
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

    return sortByIsoAsc(blocks, (block) => block.startedAt, (block) => block.blockId).map(
      cloneMessageBlock
    );
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
      if (
        (existing.turnId !== parsedBlock.turnId ||
          existing.messageId !== parsedBlock.messageId) &&
        !this.hasMessageBlockForTurnMessage({
          turnId: existing.turnId,
          messageId: existing.messageId,
          excludingBlockId: existing.blockId
        })
      ) {
        removeIndexedValue(this.messageIdsByTurn, existing.turnId, existing.messageId);
      }
    }

    this.messageBlocks.set(parsedBlock.blockId, parsedBlock);
    addUniqueValue(this.messageIdsByTurn, parsedBlock.turnId, parsedBlock.messageId);
    addUniqueValue(this.messageBlockIdsByTurn, parsedBlock.turnId, parsedBlock.blockId);
    addUniqueValue(
      this.messageBlockIdsByMessage,
      parsedBlock.messageId,
      parsedBlock.blockId
    );
    return cloneMessageBlock(parsedBlock);
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
    if (
      !this.hasMessageBlockForTurnMessage({
        turnId: existing.turnId,
        messageId: existing.messageId
      })
    ) {
      removeIndexedValue(this.messageIdsByTurn, existing.turnId, existing.messageId);
    }
    return true;
  }

  public getToolCall(toolCallId: string): ToolCall | undefined {
    const toolCall = this.toolCalls.get(toolCallId);
    return toolCall ? cloneToolCall(toolCall) : undefined;
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
    ).map(cloneToolCall);
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
    return cloneToolCall(parsedToolCall);
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
    const stream = this.terminalStreams.get(terminalId);
    return stream ? cloneTerminalStream(stream) : undefined;
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
    ).map(cloneTerminalStream);
  }

  public upsertTerminalStream(terminalStream: TerminalStream | unknown): TerminalStream {
    const parsedStream = parseTerminalStream(terminalStream);
    const existing = this.terminalStreams.get(parsedStream.terminalId);
    if (existing && existing.turnId !== parsedStream.turnId) {
      removeIndexedValue(this.terminalIdsByTurn, existing.turnId, existing.terminalId);
    }

    this.terminalStreams.set(parsedStream.terminalId, parsedStream);
    addUniqueValue(this.terminalIdsByTurn, parsedStream.turnId, parsedStream.terminalId);
    return cloneTerminalStream(parsedStream);
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
    const request = this.approvalRequests.get(requestId);
    return request ? cloneApprovalRequest(request) : undefined;
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
    ).map(cloneApprovalRequest);
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
    return cloneApprovalRequest(parsedRequest);
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

  public getRuntimeInteraction(requestId: string): RuntimeInteraction | undefined {
    const interaction = this.runtimeInteractions.get(requestId);
    return interaction ? cloneRuntimeInteraction(interaction) : undefined;
  }

  public listRuntimeInteractions(
    options: ListRuntimeInteractionsOptions = {}
  ): RuntimeInteraction[] {
    const interactions =
      options.turnId !== undefined
        ? mapIdsToValues(
            this.interactionRequestIdsByTurn.get(options.turnId),
            (requestId) => this.runtimeInteractions.get(requestId)
          )
        : options.sessionId !== undefined
          ? [...this.runtimeInteractions.values()].filter(
              (interaction) => interaction.sessionId === options.sessionId
            )
          : [...this.runtimeInteractions.values()];

    return sortByIsoAsc(
      interactions,
      (interaction) => interaction.requestedAt,
      (interaction) => interaction.requestId
    ).map(cloneRuntimeInteraction);
  }

  public upsertRuntimeInteraction(
    runtimeInteraction: RuntimeInteraction | unknown
  ): RuntimeInteraction {
    const parsedInteraction = parseRuntimeInteraction(runtimeInteraction);
    const existing = this.runtimeInteractions.get(parsedInteraction.requestId);
    if (existing && existing.turnId !== parsedInteraction.turnId) {
      removeIndexedValue(
        this.interactionRequestIdsByTurn,
        existing.turnId,
        existing.requestId
      );
    }

    this.runtimeInteractions.set(parsedInteraction.requestId, parsedInteraction);
    if (parsedInteraction.turnId) {
      addUniqueValue(
        this.interactionRequestIdsByTurn,
        parsedInteraction.turnId,
        parsedInteraction.requestId
      );
    }
    return cloneRuntimeInteraction(parsedInteraction);
  }

  public deleteRuntimeInteraction(requestId: string): boolean {
    const existing = this.runtimeInteractions.get(requestId);
    if (!existing) {
      return false;
    }
    this.runtimeInteractions.delete(requestId);
    removeIndexedValue(
      this.interactionRequestIdsByTurn,
      existing.turnId,
      existing.requestId
    );
    return true;
  }

  public getParticipant(participantId: string): AgentParticipant | undefined {
    const participant = this.participants.get(participantId);
    return participant ? this.materializeParticipant(participant) : undefined;
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
    ).map((participant) => this.materializeParticipant(participant));
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
    if (
      existing &&
      (existing.conversationId !== parsedParticipant.conversationId ||
        existing.engineId !== parsedParticipant.engineId)
    ) {
      this.removeParticipantEngineIfUnused({
        conversationId: existing.conversationId,
        engineId: existing.engineId,
        excludingParticipantId: existing.participantId
      });
    }

    const { activeSessionIds, ...storedParticipant } = parsedParticipant;
    this.participants.set(parsedParticipant.participantId, storedParticipant);
    addUniqueValue(
      this.participantIdsByConversation,
      parsedParticipant.conversationId,
      parsedParticipant.participantId
    );
    addUniqueValue(
      this.participantEngineIdsByConversation,
      parsedParticipant.conversationId,
      parsedParticipant.engineId
    );
    setIndexedValues(
      this.activeSessionIdsByParticipant,
      parsedParticipant.participantId,
      activeSessionIds
    );
    this.addExistingActiveSessionsToParticipant(storedParticipant);
    return this.materializeParticipant(storedParticipant);
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
    this.activeSessionIdsByParticipant.delete(participantId);
    this.removeParticipantEngineIfUnused({
      conversationId: existing.conversationId,
      engineId: existing.engineId,
      excludingParticipantId: existing.participantId
    });
    return true;
  }

  public getThreadGoal(sessionId: string): ThreadGoal | undefined {
    const goal = this.threadGoals.get(sessionId);
    return goal ? cloneThreadGoal(goal) : undefined;
  }

  public listThreadGoals(options: ListThreadGoalsOptions = {}): ThreadGoal[] {
    const goals = options.sessionId
      ? [this.threadGoals.get(options.sessionId)].filter(
          (goal): goal is ThreadGoal => goal !== undefined
        )
      : [...this.threadGoals.values()];

    return sortThreadGoalsByUpdatedAtAsc(goals).map(cloneThreadGoal);
  }

  public upsertThreadGoal(goal: ThreadGoal | unknown): ThreadGoal {
    const parsedGoal = parseThreadGoal(goal);
    this.threadGoals.set(parsedGoal.sessionId, parsedGoal);
    return cloneThreadGoal(parsedGoal);
  }

  public deleteThreadGoal(sessionId: string): boolean {
    return this.threadGoals.delete(sessionId);
  }

  public getSessionRelation(relationId: string): SessionRelation | undefined {
    const relation = this.sessionRelations.get(relationId);
    return relation ? cloneSessionRelation(relation) : undefined;
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
    ).map(cloneSessionRelation);
  }

  public upsertSessionRelation(relation: SessionRelation | unknown): SessionRelation {
    const parsedRelation = parseSessionRelation(relation);
    this.validateSessionRelation(parsedRelation);
    for (const candidate of this.sessionRelations.values()) {
      if (
        candidate.relationId !== parsedRelation.relationId &&
        candidate.parentSessionId === parsedRelation.parentSessionId &&
        candidate.childSessionId === parsedRelation.childSessionId
      ) {
        this.deleteSessionRelation(candidate.relationId);
      }
    }
    const existing = this.sessionRelations.get(parsedRelation.relationId);
    if (existing) {
      if (existing.childSessionId !== parsedRelation.childSessionId) {
        this.parentSessionIdByChild.delete(existing.childSessionId);
      }
      if (
        existing.parentSessionId !== parsedRelation.parentSessionId ||
        existing.childSessionId !== parsedRelation.childSessionId
      ) {
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
    return cloneSessionRelation(parsedRelation);
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

  private validateSessionConversation(session: ChatSession): void {
    for (const relation of this.sessionRelations.values()) {
      if (relation.parentSessionId === session.sessionId) {
        const child = this.sessions.get(relation.childSessionId);
        if (child && child.conversationId !== session.conversationId) {
          throw new DomainStoreRelationError(
            "conversation_mismatch",
            `Session ${session.sessionId} cannot move to conversation ${session.conversationId} while child ${child.sessionId} belongs to ${child.conversationId}.`
          );
        }
      }
      if (relation.childSessionId === session.sessionId) {
        const parent = this.sessions.get(relation.parentSessionId);
        if (parent && parent.conversationId !== session.conversationId) {
          throw new DomainStoreRelationError(
            "conversation_mismatch",
            `Session ${session.sessionId} cannot move to conversation ${session.conversationId} while parent ${parent.sessionId} belongs to ${parent.conversationId}.`
          );
        }
      }
    }
  }

  private validateSessionRelation(relation: SessionRelation): void {
    this.assertSameConversation(relation);
    this.assertSingleStructuralParent(relation);
    this.assertAcyclicRelation(relation);
  }

  private assertSameConversation(relation: SessionRelation): void {
    const parent = this.sessions.get(relation.parentSessionId);
    const child = this.sessions.get(relation.childSessionId);
    if (parent && child && parent.conversationId !== child.conversationId) {
      throw new DomainStoreRelationError(
        "conversation_mismatch",
        `Session relation ${relation.relationId} crosses conversations ${parent.conversationId} and ${child.conversationId}.`
      );
    }
  }

  private assertSingleStructuralParent(relation: SessionRelation): void {
    const existing = [...this.sessionRelations.values()].find(
      (candidate) =>
        candidate.relationId !== relation.relationId &&
        candidate.childSessionId === relation.childSessionId &&
        candidate.parentSessionId !== relation.parentSessionId
    );
    if (existing) {
      throw new DomainStoreRelationError(
        "duplicate_structural_parent",
        `Session ${relation.childSessionId} already has parent ${existing.parentSessionId}.`
      );
    }
  }

  private assertAcyclicRelation(relation: SessionRelation): void {
    if (relation.parentSessionId === relation.childSessionId) {
      throw new DomainStoreRelationError(
        "cycle",
        `Session relation ${relation.relationId} points ${relation.parentSessionId} to itself.`
      );
    }

    const visited = new Set<string>();
    let currentSessionId: string | undefined = relation.parentSessionId;
    while (currentSessionId) {
      if (currentSessionId === relation.childSessionId) {
        throw new DomainStoreRelationError(
          "cycle",
          `Session relation ${relation.relationId} creates a cycle.`
        );
      }
      if (visited.has(currentSessionId)) {
        return;
      }
      visited.add(currentSessionId);
      currentSessionId = this.findParentSessionId(currentSessionId, relation.relationId);
    }
  }

  private findParentSessionId(
    childSessionId: string,
    excludedRelationId: string
  ): string | undefined {
    const relation = [...this.sessionRelations.values()].find(
      (candidate) =>
        candidate.relationId !== excludedRelationId &&
        candidate.childSessionId === childSessionId
    );
    return relation?.parentSessionId;
  }

  private hasMessageBlockForTurnMessage(input: {
    turnId: string;
    messageId: string;
    excludingBlockId?: string;
  }): boolean {
    for (const block of this.messageBlocks.values()) {
      if (
        block.blockId !== input.excludingBlockId &&
        block.turnId === input.turnId &&
        block.messageId === input.messageId
      ) {
        return true;
      }
    }
    return false;
  }

  private removeParticipantEngineIfUnused(input: {
    conversationId: string;
    engineId: string;
    excludingSessionId?: string;
    excludingParticipantId?: string;
  }): void {
    if (
      this.hasSessionForEngine(input) ||
      this.hasParticipantForEngine(input)
    ) {
      return;
    }
    removeIndexedValue(
      this.participantEngineIdsByConversation,
      input.conversationId,
      input.engineId
    );
  }

  private hasSessionForEngine(input: {
    conversationId: string;
    engineId: string;
    excludingSessionId?: string;
  }): boolean {
    for (const session of this.sessions.values()) {
      if (
        session.sessionId !== input.excludingSessionId &&
        session.conversationId === input.conversationId &&
        session.engineId === input.engineId
      ) {
        return true;
      }
    }
    return false;
  }

  private hasParticipantForEngine(input: {
    conversationId: string;
    engineId: string;
    excludingParticipantId?: string;
  }): boolean {
    for (const participant of this.participants.values()) {
      if (
        participant.participantId !== input.excludingParticipantId &&
        participant.conversationId === input.conversationId &&
        participant.engineId === input.engineId
      ) {
        return true;
      }
    }
    return false;
  }

  private addExistingActiveSessionsToParticipant(
    participant: StoredParticipant
  ): void {
    for (const session of this.sessions.values()) {
      if (
        !session.archivedAt &&
        session.conversationId === participant.conversationId &&
        session.engineId === participant.engineId
      ) {
        addUniqueValue(
          this.activeSessionIdsByParticipant,
          participant.participantId,
          session.sessionId
        );
      }
    }
  }

  private addActiveSessionToParticipants(session: ChatSession): void {
    for (const participant of this.participants.values()) {
      if (
        participant.conversationId === session.conversationId &&
        participant.engineId === session.engineId
      ) {
        addUniqueValue(
          this.activeSessionIdsByParticipant,
          participant.participantId,
          session.sessionId
        );
      }
    }
  }

  private removeActiveSessionFromParticipants(session: ChatSession): void {
    for (const participant of this.participants.values()) {
      removeIndexedValue(
        this.activeSessionIdsByParticipant,
        participant.participantId,
        session.sessionId
      );
    }
  }

  public deleteSessionCascade(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    for (const relation of this.listSessionRelations({ sessionId })) {
      this.deleteSessionRelation(relation.relationId);
    }

    for (const interaction of this.listRuntimeInteractions({ sessionId })) {
      this.deleteRuntimeInteraction(interaction.requestId);
    }
    this.deleteThreadGoal(sessionId);

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
