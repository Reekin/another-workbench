import type {
  AgentParticipant,
  ChatSession,
  Conversation,
  DomainSnapshot,
  RuntimeEvent,
  SessionRelation
} from "@another-workbench/shared";
import { parseDomainSnapshot, parseRuntimeEvent } from "@another-workbench/shared";
import { createEmptyDomainSnapshot } from "./domain.js";
import { DomainProjector } from "./domain-projector.js";
import type { RuntimeEventEnvelope } from "./event-bus.js";
import { DomainStore } from "./domain-store.js";
import type {
  DomainSnapshotMergeOptions,
  ListApprovalRequestsOptions,
  ListMessageBlocksOptions,
  ListParticipantsOptions,
  ListRuntimeInteractionsOptions,
  ListSessionRelationsOptions,
  ListSessionsOptions,
  ListTerminalStreamsOptions,
  ListThreadGoalsOptions,
  ListToolCallsOptions,
  ListTurnsOptions
} from "./domain-store.js";
import type { DomainReadModel } from "./domain-read-model.js";

export type DomainReplicaOptions = {
  snapshot?: DomainSnapshot;
  now?: () => string;
};

export type DomainChangeSet = {
  revision: number;
  fullReset: boolean;
  conversationIds: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  turnIds: ReadonlySet<string>;
};

const addEventScopes = (
  changeSet: {
    conversationIds: Set<string>;
    sessionIds: Set<string>;
    turnIds: Set<string>;
  },
  event: RuntimeEvent,
  store: DomainStore
): void => {
  if ("conversationId" in event && typeof event.conversationId === "string") {
    changeSet.conversationIds.add(event.conversationId);
  }
  if ("sessionId" in event && typeof event.sessionId === "string") {
    changeSet.sessionIds.add(event.sessionId);
    const conversationId = store.resolveConversationIdBySessionId(event.sessionId);
    if (conversationId) {
      changeSet.conversationIds.add(conversationId);
    }
  }
  if ("turnId" in event && typeof event.turnId === "string") {
    changeSet.turnIds.add(event.turnId);
    const turn = store.getTurn(event.turnId);
    if (turn) {
      changeSet.sessionIds.add(turn.sessionId);
    }
  }
};

const preflightRuntimeEvents = (
  events: readonly RuntimeEvent[],
  store: DomainStore
): void => {
  const conversationBySession = new Map(
    store
      .listSessions({ includeArchived: true })
      .map((session) => [session.sessionId, session.conversationId] as const)
  );
  const parentByChild = new Map<string, string>();
  for (const relation of store.listSessionRelations()) {
    parentByChild.set(relation.childSessionId, relation.parentSessionId);
  }

  const assertSameConversation = (parentId: string, childId: string): void => {
    const parentConversationId = conversationBySession.get(parentId);
    const childConversationId = conversationBySession.get(childId);
    if (
      parentConversationId &&
      childConversationId &&
      parentConversationId !== childConversationId
    ) {
      throw new Error(
        `Session relation crosses conversations ${parentConversationId} and ${childConversationId}.`
      );
    }
  };

  for (const event of events) {
    if (event.type === "session.created" || event.type === "session.updated") {
      conversationBySession.set(event.sessionId, event.conversationId);
      const parentId = parentByChild.get(event.sessionId);
      if (parentId) assertSameConversation(parentId, event.sessionId);
      for (const [childId, candidateParentId] of parentByChild) {
        if (candidateParentId === event.sessionId) {
          assertSameConversation(event.sessionId, childId);
        }
      }
    }
    if (event.type !== "session.created" || !event.relation) {
      continue;
    }
    const relation = event.relation;
    const existingParent = parentByChild.get(relation.childSessionId);
    if (existingParent && existingParent !== relation.parentSessionId) {
      throw new Error(
        `Session ${relation.childSessionId} already has parent ${existingParent}.`
      );
    }
    assertSameConversation(relation.parentSessionId, relation.childSessionId);
    const visited = new Set<string>();
    let current: string | undefined = relation.parentSessionId;
    while (current) {
      if (current === relation.childSessionId) {
        throw new Error(`Session relation ${relation.relationId} creates a cycle.`);
      }
      if (visited.has(current)) break;
      visited.add(current);
      current = parentByChild.get(current);
    }
    parentByChild.set(relation.childSessionId, relation.parentSessionId);
  }
};

export class DomainReplica {
  public readonly readModel: DomainReadModel;
  private readonly store: DomainStore;
  private readonly projector: DomainProjector;
  private revision = 0;
  private readonly conversationRevisions = new Map<string, number>();
  private readonly sessionRevisions = new Map<string, number>();
  private readonly turnRevisions = new Map<string, number>();
  private scopeResetRevision = 0;
  private disposed = false;

  public constructor(options: DomainReplicaOptions = {}) {
    this.store = new DomainStore({
      snapshot: options.snapshot
    });
    this.projector = new DomainProjector({
      store: this.store,
      now: options.now
    });
    this.readModel = this.createReadModel();
  }

  public getRevision(): number {
    return this.revision;
  }

  public getConversationRevision(conversationId: string): number {
    return this.conversationRevisions.get(conversationId) ?? this.scopeResetRevision;
  }

  public getSessionRevision(sessionId: string): number {
    return this.sessionRevisions.get(sessionId) ?? this.scopeResetRevision;
  }

  public getTurnRevision(turnId: string): number {
    return this.turnRevisions.get(turnId) ?? this.scopeResetRevision;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public apply(event: RuntimeEvent | unknown, occurredAt?: string): void {
    this.applyBatch([{ event, occurredAt }]);
  }

  public applyEnvelope(
    envelope: Pick<RuntimeEventEnvelope, "event" | "occurredAt">
  ): void {
    this.apply(envelope.event, envelope.occurredAt);
  }

  public applyBatch(
    envelopes: ReadonlyArray<{
      event: RuntimeEvent | unknown;
      occurredAt?: string;
    }>
  ): DomainChangeSet {
    this.assertActive();
    if (envelopes.length === 0) {
      return this.emptyChangeSet(false);
    }
    const parsed = envelopes.map((envelope) => ({
      event: parseRuntimeEvent(envelope.event),
      occurredAt: envelope.occurredAt
    }));
    preflightRuntimeEvents(
      parsed.map((envelope) => envelope.event),
      this.store
    );
    const scopes = {
      conversationIds: new Set<string>(),
      sessionIds: new Set<string>(),
      turnIds: new Set<string>()
    };
    for (const envelope of parsed) {
      addEventScopes(scopes, envelope.event, this.store);
      this.projector.apply(envelope.event, envelope.occurredAt);
      addEventScopes(scopes, envelope.event, this.store);
    }
    return this.commitChangeSet(scopes, false);
  }

  public replaceSnapshot(snapshot: DomainSnapshot | unknown): DomainSnapshot {
    const result = this.store.replaceSnapshot(snapshot);
    this.commitFullReset();
    return result;
  }

  public mergeSnapshot(
    snapshot: DomainSnapshot | unknown,
    options: DomainSnapshotMergeOptions = {}
  ): DomainSnapshot {
    const parsedSnapshot = parseDomainSnapshot(snapshot);
    const result = this.store.mergeSnapshot(parsedSnapshot, options);
    this.commitSnapshotScopes(parsedSnapshot);
    return result;
  }

  public replaceSessionWindowSnapshot(
    sessionId: string,
    snapshot: DomainSnapshot | unknown
  ): DomainSnapshot {
    const parsedSnapshot = parseDomainSnapshot(snapshot);
    const result = this.store.replaceSessionWindowSnapshot(sessionId, parsedSnapshot);
    this.commitSnapshotScopes(parsedSnapshot, sessionId);
    return result;
  }

  public deleteSessionCascade(sessionId: string): boolean {
    this.assertActive();
    const conversationId = this.store.resolveConversationIdBySessionId(sessionId);
    const changed = this.store.deleteSessionCascade(sessionId);
    if (!changed) {
      return false;
    }
    this.commitChangeSet(
      {
        conversationIds: new Set(conversationId ? [conversationId] : []),
        sessionIds: new Set([sessionId]),
        turnIds: new Set()
      },
      false
    );
    return true;
  }

  public upsertConversation(conversation: Conversation | unknown): Conversation {
    return this.mutate(() => this.store.upsertConversation(conversation));
  }

  public upsertSession(session: ChatSession | unknown): ChatSession {
    return this.mutate(() => this.store.upsertSession(session));
  }

  public upsertParticipant(participant: AgentParticipant | unknown): AgentParticipant {
    return this.mutate(() => this.store.upsertParticipant(participant));
  }

  public upsertSessionRelation(relation: SessionRelation | unknown): SessionRelation {
    return this.mutate(() => this.store.upsertSessionRelation(relation));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.store.replaceSnapshot(createEmptyDomainSnapshot());
    this.disposed = true;
    this.commitFullReset();
  }

  public getSnapshot(): DomainSnapshot {
    return this.store.getSnapshot();
  }

  public getConversationSnapshot(conversationId: string): DomainSnapshot {
    return this.store.getConversationSnapshot(conversationId);
  }

  public getSessionSnapshot(sessionId: string): DomainSnapshot {
    return this.store.getSessionSnapshot(sessionId);
  }

  public getConversation(conversationId: string) {
    return this.store.getConversation(conversationId);
  }

  public listConversations() {
    return this.store.listConversations();
  }

  public getSession(sessionId: string) {
    return this.store.getSession(sessionId);
  }

  public listSessions(options: ListSessionsOptions = {}) {
    return this.store.listSessions(options);
  }

  public getTurn(turnId: string) {
    return this.store.getTurn(turnId);
  }

  public listTurns(options: ListTurnsOptions = {}) {
    return this.store.listTurns(options);
  }

  public getMessageBlock(blockId: string) {
    return this.store.getMessageBlock(blockId);
  }

  public listMessageBlocks(options: ListMessageBlocksOptions = {}) {
    return this.store.listMessageBlocks(options);
  }

  public getToolCall(toolCallId: string) {
    return this.store.getToolCall(toolCallId);
  }

  public listToolCalls(options: ListToolCallsOptions = {}) {
    return this.store.listToolCalls(options);
  }

  public getTerminalStream(terminalId: string) {
    return this.store.getTerminalStream(terminalId);
  }

  public listTerminalStreams(options: ListTerminalStreamsOptions = {}) {
    return this.store.listTerminalStreams(options);
  }

  public getApprovalRequest(requestId: string) {
    return this.store.getApprovalRequest(requestId);
  }

  public listApprovalRequests(options: ListApprovalRequestsOptions = {}) {
    return this.store.listApprovalRequests(options);
  }

  public getRuntimeInteraction(requestId: string) {
    return this.store.getRuntimeInteraction(requestId);
  }

  public listRuntimeInteractions(options: ListRuntimeInteractionsOptions = {}) {
    return this.store.listRuntimeInteractions(options);
  }

  public getParticipant(participantId: string) {
    return this.store.getParticipant(participantId);
  }

  public listParticipants(options: ListParticipantsOptions = {}) {
    return this.store.listParticipants(options);
  }

  public getThreadGoal(sessionId: string) {
    return this.store.getThreadGoal(sessionId);
  }

  public listThreadGoals(options: ListThreadGoalsOptions = {}) {
    return this.store.listThreadGoals(options);
  }

  public getSessionRelation(relationId: string) {
    return this.store.getSessionRelation(relationId);
  }

  public listSessionRelations(options: ListSessionRelationsOptions = {}) {
    return this.store.listSessionRelations(options);
  }

  public getSessionChildren(sessionId: string): string[] {
    return this.store.getSessionChildren(sessionId);
  }

  public getSessionParent(sessionId: string): string | undefined {
    return this.store.getSessionParent(sessionId);
  }

  public resolveConversationIdBySessionId(sessionId: string): string | undefined {
    return this.store.resolveConversationIdBySessionId(sessionId);
  }

  private mutate<T>(action: () => T): T {
    this.assertActive();
    const result = action();
    this.revision += 1;
    return result;
  }

  private emptyChangeSet(fullReset: boolean): DomainChangeSet {
    return {
      revision: this.revision,
      fullReset,
      conversationIds: new Set(),
      sessionIds: new Set(),
      turnIds: new Set()
    };
  }

  private commitFullReset(): DomainChangeSet {
    this.revision += 1;
    this.conversationRevisions.clear();
    this.sessionRevisions.clear();
    this.turnRevisions.clear();
    this.scopeResetRevision = this.revision;
    return this.emptyChangeSet(true);
  }

  private commitSnapshotScopes(snapshot: DomainSnapshot, forcedSessionId?: string): DomainChangeSet {
    const scopes = {
      conversationIds: new Set(snapshot.conversations.map((item) => item.conversationId)),
      sessionIds: new Set(snapshot.sessions.map((item) => item.sessionId)),
      turnIds: new Set(snapshot.turns.map((item) => item.turnId))
    };
    if (forcedSessionId) {
      scopes.sessionIds.add(forcedSessionId);
    }
    return this.commitChangeSet(scopes, false);
  }

  private commitChangeSet(
    scopes: {
      conversationIds: Set<string>;
      sessionIds: Set<string>;
      turnIds: Set<string>;
    },
    fullReset: boolean
  ): DomainChangeSet {
    this.revision += 1;
    for (const id of scopes.conversationIds) this.conversationRevisions.set(id, this.revision);
    for (const id of scopes.sessionIds) this.sessionRevisions.set(id, this.revision);
    for (const id of scopes.turnIds) this.turnRevisions.set(id, this.revision);
    return { revision: this.revision, fullReset, ...scopes };
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("DomainReplica has been disposed.");
    }
  }

  private createReadModel(): DomainReadModel {
    return {
      getRevision: () => this.getRevision(),
      getConversationRevision: (conversationId) =>
        this.getConversationRevision(conversationId),
      getSessionRevision: (sessionId) => this.getSessionRevision(sessionId),
      getTurnRevision: (turnId) => this.getTurnRevision(turnId),
      isDisposed: () => this.isDisposed(),
      getSnapshot: () => this.getSnapshot(),
      getConversationSnapshot: (conversationId) =>
        this.getConversationSnapshot(conversationId),
      getSessionSnapshot: (sessionId) => this.getSessionSnapshot(sessionId),
      getConversation: (conversationId) => this.getConversation(conversationId),
      listConversations: () => this.listConversations(),
      getSession: (sessionId) => this.getSession(sessionId),
      listSessions: (options = {}) => this.listSessions(options),
      getTurn: (turnId) => this.getTurn(turnId),
      listTurns: (options = {}) => this.listTurns(options),
      getMessageBlock: (blockId) => this.getMessageBlock(blockId),
      listMessageBlocks: (options = {}) => this.listMessageBlocks(options),
      getToolCall: (toolCallId) => this.getToolCall(toolCallId),
      listToolCalls: (options = {}) => this.listToolCalls(options),
      getTerminalStream: (terminalId) => this.getTerminalStream(terminalId),
      listTerminalStreams: (options = {}) => this.listTerminalStreams(options),
      getApprovalRequest: (requestId) => this.getApprovalRequest(requestId),
      listApprovalRequests: (options = {}) => this.listApprovalRequests(options),
      getRuntimeInteraction: (requestId) => this.getRuntimeInteraction(requestId),
      listRuntimeInteractions: (options = {}) =>
        this.listRuntimeInteractions(options),
      getParticipant: (participantId) => this.getParticipant(participantId),
      listParticipants: (options = {}) => this.listParticipants(options),
      getThreadGoal: (sessionId) => this.getThreadGoal(sessionId),
      listThreadGoals: (options = {}) => this.listThreadGoals(options),
      getSessionRelation: (relationId) => this.getSessionRelation(relationId),
      listSessionRelations: (options = {}) => this.listSessionRelations(options),
      getSessionChildren: (sessionId) => this.getSessionChildren(sessionId),
      getSessionParent: (sessionId) => this.getSessionParent(sessionId),
      resolveConversationIdBySessionId: (sessionId) =>
        this.resolveConversationIdBySessionId(sessionId)
    };
  }
}
