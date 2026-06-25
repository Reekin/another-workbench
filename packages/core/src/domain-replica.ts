import type {
  AgentParticipant,
  ChatSession,
  Conversation,
  DomainSnapshot,
  RuntimeEvent,
  SessionRelation
} from "@another-workbench/shared";
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

export class DomainReplica {
  public readonly readModel: DomainReadModel;
  private readonly store: DomainStore;
  private readonly projector: DomainProjector;
  private revision = 0;
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

  public isDisposed(): boolean {
    return this.disposed;
  }

  public apply(event: RuntimeEvent | unknown, occurredAt?: string): void {
    this.mutate(() => {
      this.projector.apply(event, occurredAt);
    });
  }

  public applyEnvelope(
    envelope: Pick<RuntimeEventEnvelope, "event" | "occurredAt">
  ): void {
    this.apply(envelope.event, envelope.occurredAt);
  }

  public replaceSnapshot(snapshot: DomainSnapshot | unknown): DomainSnapshot {
    return this.mutate(() => this.store.replaceSnapshot(snapshot));
  }

  public mergeSnapshot(
    snapshot: DomainSnapshot | unknown,
    options: DomainSnapshotMergeOptions = {}
  ): DomainSnapshot {
    return this.mutate(() => this.store.mergeSnapshot(snapshot, options));
  }

  public replaceSessionWindowSnapshot(
    sessionId: string,
    snapshot: DomainSnapshot | unknown
  ): DomainSnapshot {
    return this.mutate(() =>
      this.store.replaceSessionWindowSnapshot(sessionId, snapshot)
    );
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
    this.revision += 1;
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

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("DomainReplica has been disposed.");
    }
  }

  private createReadModel(): DomainReadModel {
    return {
      getRevision: () => this.getRevision(),
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
