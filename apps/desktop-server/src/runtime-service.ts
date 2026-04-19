import type {
  AgentAdapter,
  AgentAdapterRuntimeConfig
} from "@another-workbench/adapters";
import {
  RuntimeEventBus,
  SessionManager,
  type RuntimeEventEnvelope,
  type RuntimeEventFilter,
  type RuntimeEventReplayInput
} from "@another-workbench/core";
import type {
  AgentDescriptor,
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Command,
  CommandEnvelope,
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
import {
  parseAgentParticipant,
  parseApprovalRequest,
  parseChatSession,
  parseCommandEnvelope,
  parseConversation,
  parseMessageBlock,
  parseSessionRelation,
  parseTerminalStream,
  parseToolCall,
  parseTurn
} from "@another-workbench/shared";
import type {
  SessionIndexStore,
  SessionRelationIndex
} from "./session-index.js";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

type Clock = () => string;
type IdFactory = () => string;

type ActorRef = {
  participantId?: string;
  agentId?: string;
};

type SessionRecordInput = {
  sessionId: string;
  conversationId?: string;
  agentId?: string;
  status?: ChatSession["status"];
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  lastTurnId?: string;
  metadata?: Record<string, unknown>;
};

type TurnRecordInput = {
  turnId: string;
  sessionId: string;
  status?: Turn["status"];
  finishReason?: Turn["finishReason"];
  startedAt?: string;
  completedAt?: string;
  actor?: Turn["actor"];
  messageIds?: string[];
  toolCallIds?: string[];
  terminalIds?: string[];
  approvalRequestIds?: string[];
};

export type WorkbenchSessionListOptions = {
  conversationId?: string;
  includeArchived?: boolean;
};

export type AgentSelectionInput = {
  agentId: string;
  config?: Record<string, unknown>;
};

export type CommandReceipt = {
  commandId: string;
  commandType: Command["type"];
  accepted: boolean;
};

export type SnapshotResult = {
  snapshot: DomainSnapshot;
  cursor?: string;
};

export type WorkbenchAgentBinding = {
  descriptor: AgentDescriptor;
  adapter?: AgentAdapter;
  runtimeConfig?: AgentAdapterRuntimeConfig;
  providerKind?: string;
  resolveProviderSessionId?: (sessionId: string) => string | undefined;
};

export type WorkbenchRuntimeServiceOptions = {
  agents?: AgentDescriptor[];
  agentBindings?: WorkbenchAgentBinding[];
  workspaceRegistry?: WorkspaceRegistryService;
  sessionIndexStore?: SessionIndexStore;
  now?: Clock;
  createConversationId?: IdFactory;
  createRelationId?: IdFactory;
  createSessionId?: IdFactory;
  createEventId?: IdFactory;
};

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const unknownAgentId = "unknown-agent";
const unknownToolName = "unknown-tool";
const unknownApprovalTitle = "Approval request";
const runtimeErrorMessageId = (turnId: string): string => `runtime-error:${turnId}`;
const formatRuntimeErrorText = (event: Extract<RuntimeEvent, { type: "runtime.error" }>): string =>
  event.code ? `Runtime error (${event.code}): ${event.message}` : `Runtime error: ${event.message}`;

const addUnique = (items: readonly string[], value: string): string[] =>
  items.includes(value) ? [...items] : [...items, value];

const withConversationSession = (
  conversation: Conversation | undefined,
  input: {
    conversationId: string;
    sessionId: string;
    agentId: string;
    workspaceId?: string;
    timestamp: string;
  }
): Conversation =>
  parseConversation({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId ?? conversation?.workspaceId,
    participantAgentIds: addUnique(conversation?.participantAgentIds ?? [], input.agentId),
    activeSessionId: input.sessionId,
    sessionIds: addUnique(conversation?.sessionIds ?? [], input.sessionId),
    createdAt: conversation?.createdAt ?? input.timestamp,
    updatedAt: input.timestamp,
    archivedAt: conversation?.archivedAt,
    metadata: conversation?.metadata
  });

const participantIdFor = (conversationId: string, agentId: string): string =>
  `participant-${conversationId}-${agentId}`;

const actorFromEvent = (event: ActorRef): ActorRef | undefined =>
  event.participantId || event.agentId
    ? {
        participantId: event.participantId,
        agentId: event.agentId
      }
    : undefined;

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

export class WorkbenchRuntimeService {
  private readonly bindings = new Map<string, WorkbenchAgentBinding>();
  private readonly agentSelections = new Map<string, Record<string, unknown> | undefined>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly participants = new Map<string, AgentParticipant>();
  private readonly sessionRelations = new Map<string, SessionRelation>();
  private readonly turns = new Map<string, Turn>();
  private readonly messageBlocks = new Map<string, MessageBlock>();
  private readonly toolCalls = new Map<string, ToolCall>();
  private readonly terminalStreams = new Map<string, TerminalStream>();
  private readonly approvalRequests = new Map<string, ApprovalRequest>();
  private readonly adapterUnsubscribeByAgentId = new Map<string, () => void>();
  private readonly readyAgentIds = new Set<string>();
  private readonly now: Clock;
  private readonly createConversationId: IdFactory;
  private readonly createRelationId: IdFactory;
  private readonly workspaceRegistry?: WorkspaceRegistryService;
  private readonly sessionIndexStore?: SessionIndexStore;
  private readonly sessionManager: SessionManager;
  private readonly eventBus: RuntimeEventBus;
  private selectedAgentId: string | undefined;

  public constructor(options: WorkbenchRuntimeServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createConversationId =
      options.createConversationId ?? (() => createOpaqueId("conversation"));
    this.createRelationId =
      options.createRelationId ?? (() => createOpaqueId("relation"));
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.sessionManager = new SessionManager({
      now: this.now,
      createSessionId: options.createSessionId
    });
    this.eventBus = new RuntimeEventBus({
      now: this.now,
      createId: options.createEventId,
      resolveConversationIdBySessionId: (sessionId) =>
        this.sessionManager.getSession(sessionId)?.conversationId
    });

    for (const agent of options.agents ?? []) {
      this.registerAgent(agent);
    }
    for (const binding of options.agentBindings ?? []) {
      this.registerAgentBinding(binding);
    }
    this.selectedAgentId =
      options.agentBindings?.[0]?.descriptor.agentId ??
      options.agents?.[0]?.agentId;
  }

  public registerAgent(agent: AgentDescriptor): void {
    const existing = this.bindings.get(agent.agentId);
    this.bindings.set(agent.agentId, {
      descriptor: {
        ...agent,
        capabilities: [...agent.capabilities]
      },
      adapter: existing?.adapter,
      runtimeConfig: existing?.runtimeConfig,
      providerKind: existing?.providerKind,
      resolveProviderSessionId: existing?.resolveProviderSessionId
    });
    if (!this.selectedAgentId) {
      this.selectedAgentId = agent.agentId;
    }
  }

  public registerAgentBinding(binding: WorkbenchAgentBinding): void {
    this.bindings.set(binding.descriptor.agentId, {
      descriptor: {
        ...binding.descriptor,
        capabilities: [...binding.descriptor.capabilities]
      },
      adapter: binding.adapter,
      runtimeConfig: binding.runtimeConfig,
      providerKind: binding.providerKind,
      resolveProviderSessionId: binding.resolveProviderSessionId
    });
    if (!this.selectedAgentId) {
      this.selectedAgentId = binding.descriptor.agentId;
    }
  }

  public listAgents(): AgentDescriptor[] {
    return [...this.bindings.values()].map((binding) => ({
      ...binding.descriptor,
      capabilities: [...binding.descriptor.capabilities]
    }));
  }

  public selectAgent(input: AgentSelectionInput): { selectedAgentId: string } {
    this.assertAgentExists(input.agentId);
    this.selectedAgentId = input.agentId;
    this.agentSelections.set(
      input.agentId,
      input.config ? { ...input.config } : undefined
    );
    return {
      selectedAgentId: input.agentId
    };
  }

  public getSelectedAgentId(): string | undefined {
    return this.selectedAgentId;
  }

  public getWorkspaceRegistry(): WorkspaceRegistryService | undefined {
    return this.workspaceRegistry;
  }

  public getSessionIndexStore(): SessionIndexStore | undefined {
    return this.sessionIndexStore;
  }

  public hydrateDiscoveredSession(
    snapshot: HydratedSessionSnapshot,
    input: {
      relatedIndexRelations?: SessionRelationIndex[];
    } = {}
  ): ChatSession {
    const existingConversation = this.conversations.get(
      snapshot.conversation.conversationId
    );
    this.conversations.set(
      snapshot.conversation.conversationId,
      parseConversation({
        ...existingConversation,
        ...snapshot.conversation,
        participantAgentIds: addUnique(
          existingConversation?.participantAgentIds ?? [],
          snapshot.session.agentId
        ),
        sessionIds: addUnique(
          existingConversation?.sessionIds ?? [],
          snapshot.session.sessionId
        ),
        activeSessionId: snapshot.session.sessionId
      })
    );

    const session = this.sessionManager.loadSession(snapshot.session);
    this.bindRuntime(session);
    this.ensureParticipantForSession(session);

    for (const relation of snapshot.sessionRelations) {
      this.sessionRelations.set(relation.relationId, parseSessionRelation(relation));
    }
    for (const relation of input.relatedIndexRelations ?? []) {
      const relationId = `${relation.parentSessionId}:${relation.childSessionId}:${relation.relationType}`;
      this.sessionRelations.set(
        relationId,
        parseSessionRelation({
          relationId,
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType,
          sourceTurnId: relation.sourceTurnId,
          createdAt: relation.createdAt
        })
      );
    }
    for (const turn of snapshot.turns) {
      this.turns.set(turn.turnId, parseTurn(turn));
    }
    for (const block of snapshot.messageBlocks) {
      this.messageBlocks.set(block.blockId, parseMessageBlock(block));
    }
    for (const toolCall of snapshot.toolCalls) {
      this.toolCalls.set(toolCall.toolCallId, parseToolCall(toolCall));
    }
    for (const terminalStream of snapshot.terminalStreams) {
      this.terminalStreams.set(
        terminalStream.terminalId,
        parseTerminalStream(terminalStream)
      );
    }

    return session;
  }

  public async executeCommand(input: CommandEnvelope): Promise<CommandReceipt> {
    const envelope = parseCommandEnvelope(input);
    switch (envelope.command.type) {
      case "initialize":
        if (this.selectedAgentId) {
          await this.ensureAdapterReady(this.selectedAgentId);
        }
        return this.accept(envelope, true);
      case "listSessions":
        return this.accept(envelope, true);
      case "createSession":
        await this.createSession(envelope.command);
        return this.accept(envelope, true);
      case "resumeSession":
        await this.handleResumeSession(envelope.command.sessionId);
        return this.accept(envelope, true);
      case "archiveSession":
        await this.handleArchiveSession(envelope.command.sessionId);
        return this.accept(envelope, true);
      case "forkSession":
        await this.handleForkSession(
          envelope.command.sessionId,
          envelope.command.fromTurnId
        );
        return this.accept(envelope, true);
      case "disposeSession":
        await this.handleDisposeSession(envelope.command.sessionId);
        return this.accept(envelope, true);
      case "sendUserMessage": {
        const sessionId = envelope.command.sessionId;
        this.commitLocalUserMessage(envelope.command);
        return this.forwardSessionCommand(sessionId, envelope, {
          before: () => {
            this.setSessionStatus(sessionId, "running");
          }
        });
      }
      case "interruptTurn":
        return this.forwardSessionCommand(envelope.command.sessionId, envelope);
      case "respondApproval": {
        const sessionId = envelope.command.sessionId;
        return this.forwardSessionCommand(sessionId, envelope);
      }
      default: {
        const exhaustive: never = envelope.command;
        return exhaustive;
      }
    }
  }

  public listSessions(options: WorkbenchSessionListOptions = {}): ChatSession[] {
    return this.sessionManager.listSessions(options);
  }

  public async createSession(
    command: Extract<Command, { type: "createSession" }>
  ): Promise<ChatSession> {
    return this.handleCreateSession(command);
  }

  public resolveConversationIdForSession(
    sessionId: string
  ): string | undefined {
    return this.sessionManager.getSession(sessionId)?.conversationId;
  }

  public getSnapshot(): DomainSnapshot {
    return {
      conversations: sortByIsoAsc(
        this.conversations.values(),
        (conversation) => conversation.createdAt,
        (conversation) => conversation.conversationId
      ),
      sessions: this.sessionManager.listSessions({ includeArchived: true }),
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
      participants: [...this.participants.values()],
      sessionRelations: sortByIsoAsc(
        this.sessionRelations.values(),
        (relation) => relation.createdAt,
        (relation) => relation.relationId
      )
    };
  }

  public getSnapshotResult(): SnapshotResult {
    return {
      snapshot: this.getSnapshot(),
      cursor: this.eventBus.getLatestCursor()
    };
  }

  public subscribe(
    listener: (envelope: EventEnvelope) => void,
    filter: RuntimeEventFilter = {}
  ): () => void {
    return this.eventBus.subscribe((envelope) => {
      listener(this.toSharedEnvelope(envelope));
    }, filter);
  }

  public subscribeFromCursor(
    listener: (envelope: EventEnvelope) => void,
    input: RuntimeEventReplayInput = {}
  ): () => void {
    return this.eventBus.subscribeWithReplay((envelope) => {
      listener(this.toSharedEnvelope(envelope));
    }, input);
  }

  public replay(input: RuntimeEventReplayInput = {}): EventEnvelope[] {
    return this.eventBus.replay(input).map((envelope) => this.toSharedEnvelope(envelope));
  }

  public async dispose(): Promise<void> {
    for (const unsubscribe of this.adapterUnsubscribeByAgentId.values()) {
      unsubscribe();
    }
    this.adapterUnsubscribeByAgentId.clear();

    for (const binding of this.bindings.values()) {
      await binding.adapter?.dispose();
    }
    this.readyAgentIds.clear();
  }

  private accept(envelope: CommandEnvelope, accepted: boolean): CommandReceipt {
    return {
      commandId: envelope.commandId,
      commandType: envelope.command.type,
      accepted
    };
  }

  private async forwardSessionCommand(
    sessionId: string,
    envelope: CommandEnvelope,
    hooks: { before?: () => void } = {}
  ): Promise<CommandReceipt> {
    const session = this.requireSession(sessionId);
    const binding = this.requireBinding(session.agentId);
    if (!binding.adapter) {
      return this.accept(envelope, false);
    }

    await this.ensureAdapterReady(session.agentId);
    hooks.before?.();
    const result = await binding.adapter.executeCommand(envelope);
    return this.accept(envelope, result.accepted);
  }

  private async handleCreateSession(
    command: Extract<Command, { type: "createSession" }>
  ): Promise<ChatSession> {
    this.assertAgentExists(command.agentId);
    const timestamp = this.now();
    const conversationId = command.conversationId ?? this.createConversationId();
    const session = this.sessionManager.createSession({
      conversationId,
      agentId: command.agentId,
      metadata: command.metadata
    });

    const conversation = withConversationSession(
      this.conversations.get(conversationId),
      {
        conversationId,
        sessionId: session.sessionId,
        agentId: command.agentId,
        workspaceId: command.workspaceId,
        timestamp
      }
    );
    this.conversations.set(conversationId, conversation);
    this.bindRuntime(session);
    this.ensureParticipantForSession(session);
    await this.persistSessionIndexEntry(session, conversation.workspaceId);
    await this.workspaceRegistry?.setLastActiveSelection({
      workspaceId: conversation.workspaceId,
      sessionId: session.sessionId
    });

    this.commitRuntimeEvent({
      type: "session.created",
      conversationId,
      sessionId: session.sessionId,
      agentId: session.agentId,
      status: session.status
    });
    this.publishConversationUpdated(conversation);

    return session;
  }

  private async handleResumeSession(sessionId: string): Promise<ChatSession> {
    const timestamp = this.now();
    const session = this.sessionManager.resumeSession(sessionId);
    const conversation = this.requireConversation(session.conversationId);
    const updatedConversation = parseConversation({
      ...conversation,
      activeSessionId: session.sessionId,
      updatedAt: timestamp
    });
    this.conversations.set(updatedConversation.conversationId, updatedConversation);
    this.ensureParticipantForSession(session);

    this.commitRuntimeEvent({
      type: "session.updated",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      status: session.status
    });
    this.publishConversationUpdated(updatedConversation);
    await this.persistSessionIndexEntry(session, updatedConversation.workspaceId);
    await this.workspaceRegistry?.setLastActiveSelection({
      workspaceId: updatedConversation.workspaceId,
      sessionId: session.sessionId
    });

    return session;
  }

  private async handleArchiveSession(sessionId: string): Promise<ChatSession> {
    const timestamp = this.now();
    const session = this.sessionManager.archiveSession(sessionId);
    const conversation = this.requireConversation(session.conversationId);
    const nextActiveSessionId = this.resolveNextActiveSessionId(
      session.conversationId,
      session.sessionId
    );
    const updatedConversation = parseConversation({
      ...conversation,
      activeSessionId: nextActiveSessionId,
      updatedAt: timestamp
    });
    this.conversations.set(updatedConversation.conversationId, updatedConversation);
    this.detachSessionFromParticipant(session);

    this.commitRuntimeEvent({
      type: "session.archived",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      archivedAt: session.archivedAt ?? timestamp
    });
    this.publishConversationUpdated(updatedConversation);
    await this.persistSessionIndexEntry(session, updatedConversation.workspaceId);

    return session;
  }

  private async handleForkSession(
    sessionId: string,
    fromTurnId?: string
  ): Promise<ChatSession> {
    const parentSession = this.requireSession(sessionId);
    const timestamp = this.now();
    const childSession = this.sessionManager.createSession({
      conversationId: parentSession.conversationId,
      agentId: parentSession.agentId,
      metadata: parentSession.metadata
    });
    const relation = parseSessionRelation({
      relationId: this.createRelationId(),
      parentSessionId: parentSession.sessionId,
      childSessionId: childSession.sessionId,
      relationType: "fork",
      sourceTurnId: fromTurnId,
      createdAt: timestamp
    });
    this.sessionRelations.set(relation.relationId, relation);

    const conversation = withConversationSession(
      this.requireConversation(parentSession.conversationId),
      {
        conversationId: parentSession.conversationId,
        sessionId: childSession.sessionId,
        agentId: childSession.agentId,
        timestamp
      }
    );
    this.conversations.set(conversation.conversationId, conversation);
    this.bindRuntime(childSession);
    this.ensureParticipantForSession(childSession);
    await this.persistSessionIndexEntry(childSession, conversation.workspaceId);
    if (conversation.workspaceId) {
      await this.sessionIndexStore?.upsertRelation({
        workspaceId: conversation.workspaceId,
        parentSessionId: parentSession.sessionId,
        childSessionId: childSession.sessionId,
        relationType: relation.relationType,
        sourceTurnId: relation.sourceTurnId,
        createdAt: relation.createdAt
      });
      await this.workspaceRegistry?.setLastActiveSelection({
        workspaceId: conversation.workspaceId,
        sessionId: childSession.sessionId
      });
    }

    this.commitRuntimeEvent({
      type: "session.created",
      conversationId: childSession.conversationId,
      sessionId: childSession.sessionId,
      agentId: childSession.agentId,
      status: childSession.status,
      relation
    });
    this.publishConversationUpdated(conversation);

    return childSession;
  }

  private async handleDisposeSession(sessionId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    this.commitRuntimeEvent({
      type: "session.disposed",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      disposedAt: this.now()
    });
    this.publishConversationUpdated(this.requireConversation(session.conversationId));
    return true;
  }

  private commitLocalUserMessage(
    command: Extract<Command, { type: "sendUserMessage" }>
  ): void {
    const turnId = `user-turn-${command.messageId}`;
    this.commitRuntimeEvent({
      type: "turn.started",
      sessionId: command.sessionId,
      turnId
    });
    this.commitRuntimeEvent({
      type: "message.started",
      sessionId: command.sessionId,
      turnId,
      messageId: command.messageId,
      role: "user"
    });
    if (command.content.length > 0) {
      this.commitRuntimeEvent({
        type: "message.delta",
        sessionId: command.sessionId,
        turnId,
        messageId: command.messageId,
        delta: command.content
      });
    }
    this.commitRuntimeEvent({
      type: "message.completed",
      sessionId: command.sessionId,
      turnId,
      messageId: command.messageId,
      finalText: command.content
    });
    this.commitRuntimeEvent({
      type: "turn.completed",
      sessionId: command.sessionId,
      turnId,
      finishReason: "completed"
    });
  }

  private async persistSessionIndexEntry(
    session: ChatSession,
    workspaceId?: string
  ): Promise<void> {
    if (!workspaceId || !this.sessionIndexStore) {
      return;
    }
    const binding = this.bindings.get(session.agentId);
    await this.sessionIndexStore.upsertSession({
      workspaceId,
      session,
      providerKind: binding?.providerKind,
      providerSessionId: binding?.resolveProviderSessionId?.(session.sessionId)
    });
  }

  private async persistSessionIndexForSessionId(sessionId: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }
    const conversation = this.conversations.get(session.conversationId);
    await this.persistSessionIndexEntry(session, conversation?.workspaceId);
  }

  private async syncSessionIndexFromRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (!("sessionId" in event) || typeof event.sessionId !== "string") {
      return;
    }
    await this.persistSessionIndexForSessionId(event.sessionId);
  }

  private bindRuntime(session: ChatSession): void {
    const binding = this.bindings.get(session.agentId);
    if (!binding?.adapter) {
      return;
    }

    this.sessionManager.bindRuntime(session.sessionId, {
      runtimeId: `${session.agentId}:${session.sessionId}`,
      handle: binding.adapter,
      attachedAt: this.now(),
      metadata: {
        agentId: session.agentId
      }
    });
  }

  private ensureParticipantForSession(session: ChatSession): AgentParticipant {
    const conversation = this.requireConversation(session.conversationId);
    const binding = this.requireBinding(session.agentId);
    const participantId = participantIdFor(session.conversationId, session.agentId);
    const existing = this.participants.get(participantId);
    const role =
      existing?.role ??
      (conversation.participantAgentIds[0] === session.agentId ? "primary" : "secondary");
    const participant = parseAgentParticipant({
      participantId,
      conversationId: session.conversationId,
      agentId: session.agentId,
      role,
      capabilities: binding.descriptor.capabilities,
      activeSessionIds: this.getActiveSessionIdsForParticipant(
        session.conversationId,
        session.agentId
      ),
      metadata: existing?.metadata
    });
    this.participants.set(participantId, participant);

    this.commitRuntimeEvent({
      type: "participant.updated",
      conversationId: session.conversationId,
      participantId: participant.participantId,
      agentId: participant.agentId,
      role: participant.role,
      capabilities: participant.capabilities
    });

    return participant;
  }

  private detachSessionFromParticipant(session: ChatSession): void {
    this.syncParticipantState(session.conversationId, session.agentId);
  }

  private async ensureAdapterReady(agentId: string): Promise<void> {
    if (this.readyAgentIds.has(agentId)) {
      return;
    }
    const binding = this.requireBinding(agentId);
    if (!binding.adapter) {
      return;
    }

    await binding.adapter.initialize({
      ...(binding.runtimeConfig ?? {}),
      metadata: {
        ...(binding.runtimeConfig?.metadata ?? {}),
        selectedConfig: this.agentSelections.get(agentId)
      }
    });

    const unsubscribe = binding.adapter.subscribe((envelope) => {
      void this.ingestAdapterEvent(envelope);
    });
    this.adapterUnsubscribeByAgentId.set(agentId, unsubscribe);
    this.readyAgentIds.add(agentId);
  }

  private async ingestAdapterEvent(envelope: EventEnvelope): Promise<void> {
    this.applyRuntimeEvent(envelope.event, envelope.occurredAt);
    await this.syncSessionIndexFromRuntimeEvent(envelope.event);
    this.eventBus.publish(envelope.event);
  }

  private commitRuntimeEvent(event: RuntimeEvent): void {
    this.applyRuntimeEvent(event);
    this.eventBus.publish(event);
  }

  private applyRuntimeEvent(event: RuntimeEvent, occurredAt?: string): void {
    const timestamp = occurredAt ?? this.now();
    switch (event.type) {
      case "conversation.updated": {
        const existing = this.conversations.get(event.conversationId);
        const participantAgentIds = [
          ...(existing?.participantAgentIds ?? []),
          ...event.participantIds
            .map((participantId) => this.participants.get(participantId)?.agentId)
            .filter((agentId): agentId is string => Boolean(agentId))
        ].reduce<string[]>((acc, value) => addUnique(acc, value), []);
        const sessionIds = this.sessionManager
          .listSessions({
            conversationId: event.conversationId,
            includeArchived: true
          })
          .map((session) => session.sessionId);
        this.conversations.set(
          event.conversationId,
          parseConversation({
            conversationId: event.conversationId,
            workspaceId: event.workspaceId ?? existing?.workspaceId,
            participantAgentIds,
            activeSessionId: event.activeSessionId ?? existing?.activeSessionId,
            sessionIds: sessionIds.length > 0 ? sessionIds : existing?.sessionIds ?? [],
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
            archivedAt: existing?.archivedAt,
            metadata: existing?.metadata
          })
        );
        return;
      }
      case "session.created": {
        const session = this.upsertSessionRecord({
          sessionId: event.sessionId,
          conversationId: event.conversationId,
          agentId: event.agentId,
          status: event.status,
          createdAt:
            this.sessionManager.getSession(event.sessionId)?.createdAt ?? timestamp,
          updatedAt: timestamp
        });
        this.bindRuntime(session);
        this.conversations.set(
          event.conversationId,
          withConversationSession(this.conversations.get(event.conversationId), {
            conversationId: event.conversationId,
            sessionId: event.sessionId,
            agentId: event.agentId,
            timestamp
          })
        );
        if (event.relation) {
          this.sessionRelations.set(
            event.relation.relationId,
            parseSessionRelation(event.relation)
          );
        }
        this.syncParticipantState(event.conversationId, event.agentId);
        return;
      }
      case "session.updated": {
        const existing = this.sessionManager.getSession(event.sessionId);
        const session = this.upsertSessionRecord({
          sessionId: event.sessionId,
          conversationId: event.conversationId,
          agentId: existing?.agentId ?? unknownAgentId,
          status: event.status,
          title: existing?.title,
          metadata: event.metadata ?? existing?.metadata,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          archivedAt: existing?.archivedAt,
          lastTurnId: existing?.lastTurnId
        });
        const existingConversation = this.conversations.get(event.conversationId);
        this.conversations.set(
          event.conversationId,
          parseConversation({
            ...withConversationSession(existingConversation, {
              conversationId: event.conversationId,
              sessionId: event.sessionId,
              agentId: session.agentId,
              timestamp
            }),
            activeSessionId:
              event.status === "running" || event.status === "awaiting_approval"
                ? event.sessionId
                : existingConversation?.activeSessionId
          })
        );
        this.syncParticipantState(event.conversationId, session.agentId);
        return;
      }
      case "session.archived": {
        const existing = this.sessionManager.getSession(event.sessionId);
        if (existing) {
          const session = this.upsertSessionRecord({
            ...existing,
            archivedAt: event.archivedAt,
            updatedAt: event.archivedAt
          });
          const conversation = this.conversations.get(event.conversationId);
          if (conversation) {
            this.conversations.set(
              event.conversationId,
              parseConversation({
                ...conversation,
                activeSessionId: this.resolveNextActiveSessionId(
                  event.conversationId,
                  event.sessionId
                ),
                updatedAt: event.archivedAt
              })
            );
          }
          this.syncParticipantState(event.conversationId, session.agentId);
        }
        return;
      }
      case "session.disposed": {
        const existing = this.sessionManager.getSession(event.sessionId);
        const conversation = this.conversations.get(event.conversationId);
        const agentId = existing?.agentId;

        this.sessionManager.disposeSession(event.sessionId);
        this.removeSessionArtifacts(event.sessionId);

        if (conversation) {
          this.conversations.set(
            event.conversationId,
            parseConversation({
              ...conversation,
              sessionIds: conversation.sessionIds.filter(
                (sessionId) => sessionId !== event.sessionId
              ),
              activeSessionId: this.resolveNextActiveSessionId(
                event.conversationId,
                event.sessionId
              ),
              updatedAt: event.disposedAt
            })
          );
        }

        if (agentId) {
          this.syncParticipantState(event.conversationId, agentId);
        }
        return;
      }
      case "participant.updated": {
        const participant = parseAgentParticipant({
          participantId: event.participantId,
          conversationId: event.conversationId,
          agentId: event.agentId,
          role: event.role,
          capabilities: event.capabilities,
          activeSessionIds: this.getActiveSessionIdsForParticipant(
            event.conversationId,
            event.agentId
          )
        });
        this.participants.set(participant.participantId, participant);
        const conversation = this.conversations.get(event.conversationId);
        this.conversations.set(
          event.conversationId,
          parseConversation({
            conversationId: event.conversationId,
            workspaceId: conversation?.workspaceId,
            participantAgentIds: addUnique(
              conversation?.participantAgentIds ?? [],
              event.agentId
            ),
            activeSessionId: conversation?.activeSessionId,
            sessionIds:
              conversation?.sessionIds ??
              this.sessionManager
                .listSessions({
                  conversationId: event.conversationId,
                  includeArchived: true
                })
                .map((session) => session.sessionId),
            createdAt: conversation?.createdAt ?? timestamp,
            updatedAt: timestamp,
            archivedAt: conversation?.archivedAt,
            metadata: conversation?.metadata
          })
        );
        return;
      }
      case "turn.started": {
        this.upsertTurnRecord({
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "started",
          startedAt: timestamp
        });
        this.setSessionStatus(event.sessionId, "running", timestamp, event.turnId);
        return;
      }
      case "turn.completed": {
        const existing = this.turns.get(event.turnId);
        this.upsertTurnRecord({
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "completed",
          finishReason: event.finishReason,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: timestamp,
          actor: existing?.actor,
          messageIds: existing?.messageIds,
          toolCallIds: existing?.toolCallIds,
          terminalIds: existing?.terminalIds,
          approvalRequestIds: existing?.approvalRequestIds
        });
        this.setSessionStatus(
          event.sessionId,
          event.finishReason === "failed" ? "error" : "idle",
          timestamp,
          event.turnId
        );
        void this.sessionIndexStore?.markSessionUnreadCompleted(event.sessionId);
        return;
      }
      case "message.started": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const blockId = `${event.messageId}:md`;
        const existing = this.messageBlocks.get(blockId);
        this.messageBlocks.set(
          blockId,
          parseMessageBlock({
            blockId,
            messageId: event.messageId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            role: existing?.role ?? event.role,
            kind: "markdown",
            text: existing?.text ?? "",
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "messageIds", event.messageId, timestamp);
        return;
      }
      case "message.delta": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const blockId = `${event.messageId}:md`;
        const existing = this.messageBlocks.get(blockId);
        this.messageBlocks.set(
          blockId,
          parseMessageBlock({
            blockId,
            messageId: event.messageId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            role: existing?.role ?? "assistant",
            kind: "markdown",
            text: `${existing?.text ?? ""}${event.delta}`,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "messageIds", event.messageId, timestamp);
        return;
      }
      case "message.completed": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const blockId = `${event.messageId}:md`;
        const current = this.messageBlocks.get(blockId);
        this.messageBlocks.set(
          blockId,
          parseMessageBlock({
            blockId,
            messageId: event.messageId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            role: current?.role ?? "assistant",
            kind: "markdown",
            text: event.finalText ?? current?.text ?? "",
            actor: current?.actor ?? actor,
            startedAt: current?.startedAt ?? timestamp,
            completedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "messageIds", event.messageId, timestamp);
        return;
      }
      case "tool.started": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        this.toolCalls.set(
          event.toolCallId,
          parseToolCall({
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolName: event.toolName,
            status: "running",
            inputSummary: event.inputSummary,
            actor,
            startedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "toolCallIds", event.toolCallId, timestamp);
        return;
      }
      case "tool.delta": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.toolCalls.get(event.toolCallId);
        this.toolCalls.set(
          event.toolCallId,
          parseToolCall({
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolName: existing?.toolName ?? unknownToolName,
            status: existing?.status ?? "running",
            inputSummary: existing?.inputSummary,
            outputSummary: `${existing?.outputSummary ?? ""}${event.delta}`,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "toolCallIds", event.toolCallId, timestamp);
        return;
      }
      case "tool.completed": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.toolCalls.get(event.toolCallId);
        this.toolCalls.set(
          event.toolCallId,
          parseToolCall({
            toolCallId: event.toolCallId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolName: existing?.toolName ?? unknownToolName,
            status: event.status,
            inputSummary: existing?.inputSummary,
            outputSummary: event.outputSummary ?? existing?.outputSummary,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "toolCallIds", event.toolCallId, timestamp);
        return;
      }
      case "terminal.started": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        this.terminalStreams.set(
          event.terminalId,
          parseTerminalStream({
            terminalId: event.terminalId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            status: "running",
            outputText: "",
            actor,
            startedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "terminalIds", event.terminalId, timestamp);
        return;
      }
      case "terminal.output": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.terminalStreams.get(event.terminalId);
        this.terminalStreams.set(
          event.terminalId,
          parseTerminalStream({
            terminalId: event.terminalId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: existing?.toolCallId,
            status: existing?.status ?? "running",
            outputText: `${existing?.outputText ?? ""}${event.chunk}`,
            exitCode: existing?.exitCode,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: existing?.completedAt
          })
        );
        this.appendTurnCollection(event.turnId, "terminalIds", event.terminalId, timestamp);
        return;
      }
      case "terminal.completed": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.terminalStreams.get(event.terminalId);
        this.terminalStreams.set(
          event.terminalId,
          parseTerminalStream({
            terminalId: event.terminalId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: existing?.toolCallId,
            status: event.exitCode && event.exitCode !== 0 ? "failed" : "completed",
            outputText: existing?.outputText ?? "",
            exitCode: event.exitCode,
            actor: existing?.actor ?? actor,
            startedAt: existing?.startedAt ?? timestamp,
            completedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "terminalIds", event.terminalId, timestamp);
        return;
      }
      case "approval.requested": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        this.approvalRequests.set(
          event.requestId,
          parseApprovalRequest({
            requestId: event.requestId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            approvalKind: event.approvalKind,
            status: "pending",
            title: event.title,
            details: event.details,
            actor,
            requestedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "approvalRequestIds", event.requestId, timestamp);
        this.setSessionStatus(event.sessionId, "awaiting_approval", timestamp, event.turnId);
        return;
      }
      case "approval.resolved": {
        const actor = actorFromEvent(event);
        this.markTurnStreaming(event.turnId, event.sessionId, timestamp, actor);
        const existing = this.approvalRequests.get(event.requestId);
        this.approvalRequests.set(
          event.requestId,
          parseApprovalRequest({
            requestId: event.requestId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            approvalKind: existing?.approvalKind ?? "custom",
            status:
              event.action === "approve"
                ? "approved"
                : event.action === "deny"
                  ? "denied"
                  : "deferred",
            title: existing?.title ?? unknownApprovalTitle,
            details: existing?.details,
            note: existing?.note,
            actor: existing?.actor ?? actor,
            requestedAt: existing?.requestedAt ?? timestamp,
            resolvedAt: timestamp
          })
        );
        this.appendTurnCollection(event.turnId, "approvalRequestIds", event.requestId, timestamp);
        return;
      }
      case "runtime.error": {
        if (event.sessionId && event.turnId) {
          const existingTurn = this.turns.get(event.turnId);
          const existingMessageId =
            existingTurn?.messageIds.find((messageId) => {
              const block = this.messageBlocks.get(`${messageId}:md`);
              return block && (block.text ?? "").trim().length === 0;
            }) ?? runtimeErrorMessageId(event.turnId);
          const blockId = `${existingMessageId}:md`;
          const existingBlock = this.messageBlocks.get(blockId);

          this.messageBlocks.set(
            blockId,
            parseMessageBlock({
              blockId,
              messageId: existingMessageId,
              sessionId: event.sessionId,
              turnId: event.turnId,
              role: "system",
              kind: "markdown",
              text: formatRuntimeErrorText(event),
              actor: existingBlock?.actor,
              startedAt: existingBlock?.startedAt ?? timestamp,
              completedAt: timestamp
            })
          );
          this.appendTurnCollection(
            event.turnId,
            "messageIds",
            existingMessageId,
            timestamp
          );
          this.upsertTurnRecord({
            turnId: event.turnId,
            sessionId: event.sessionId,
            status: "completed",
            finishReason: "failed",
            startedAt: existingTurn?.startedAt ?? timestamp,
            completedAt: timestamp,
            actor: existingTurn?.actor,
            messageIds: existingTurn?.messageIds,
            toolCallIds: existingTurn?.toolCallIds,
            terminalIds: existingTurn?.terminalIds,
            approvalRequestIds: existingTurn?.approvalRequestIds
          });
        }
        if (event.sessionId) {
          this.setSessionStatus(event.sessionId, "error", timestamp, event.turnId);
        }
        return;
      }
      default:
        return;
    }
  }

  private setSessionStatus(
    sessionId: string,
    status: ChatSession["status"],
    timestamp = this.now(),
    lastTurnId?: string
  ): void {
    const existing = this.sessionManager.getSession(sessionId);
    if (!existing) {
      return;
    }
    const updated = this.upsertSessionRecord({
      ...existing,
      status,
      updatedAt: timestamp,
      lastTurnId: lastTurnId ?? existing.lastTurnId
    });
    const conversation = this.conversations.get(updated.conversationId);
    if (conversation) {
      this.conversations.set(
        conversation.conversationId,
        parseConversation({
          ...conversation,
          activeSessionId:
            status === "running" || status === "awaiting_approval"
              ? updated.sessionId
              : conversation.activeSessionId,
          updatedAt: timestamp
        })
      );
    }
  }

  private publishConversationUpdated(conversation: Conversation): void {
    const participantIds = [...this.participants.values()]
      .filter((participant) => participant.conversationId === conversation.conversationId)
      .map((participant) => participant.participantId);

    this.commitRuntimeEvent({
      type: "conversation.updated",
      conversationId: conversation.conversationId,
      workspaceId: conversation.workspaceId,
      activeSessionId: conversation.activeSessionId,
      participantIds
    });
  }


  private resolveNextActiveSessionId(
    conversationId: string,
    excludedSessionId?: string
  ): string | undefined {
    return this.sessionManager
      .listSessions({
        conversationId,
        includeArchived: false
      })
      .map((session) => session.sessionId)
      .find((sessionId) => sessionId !== excludedSessionId);
  }

  private upsertSessionRecord(input: SessionRecordInput): ChatSession {
    const existing = this.sessionManager.getSession(input.sessionId);
    const session = parseChatSession({
      sessionId: input.sessionId,
      conversationId: input.conversationId ?? existing?.conversationId,
      agentId: input.agentId ?? existing?.agentId ?? unknownAgentId,
      status: input.status ?? existing?.status ?? "idle",
      title: input.title ?? existing?.title,
      createdAt: input.createdAt ?? existing?.createdAt ?? this.now(),
      updatedAt: input.updatedAt ?? existing?.updatedAt ?? this.now(),
      archivedAt: input.archivedAt ?? existing?.archivedAt,
      lastTurnId: input.lastTurnId ?? existing?.lastTurnId,
      metadata: input.metadata ?? existing?.metadata
    });
    return this.sessionManager.loadSession(session);
  }

  private upsertTurnRecord(input: TurnRecordInput): Turn {
    const existing = this.turns.get(input.turnId);
    const turn = parseTurn({
      turnId: input.turnId,
      sessionId: input.sessionId,
      status: input.status ?? existing?.status ?? "streaming",
      finishReason: input.finishReason ?? existing?.finishReason,
      startedAt: input.startedAt ?? existing?.startedAt ?? this.now(),
      completedAt: input.completedAt ?? existing?.completedAt,
      actor: input.actor ?? existing?.actor,
      messageIds: input.messageIds ?? existing?.messageIds ?? [],
      toolCallIds: input.toolCallIds ?? existing?.toolCallIds ?? [],
      terminalIds: input.terminalIds ?? existing?.terminalIds ?? [],
      approvalRequestIds: input.approvalRequestIds ?? existing?.approvalRequestIds ?? []
    });
    this.turns.set(turn.turnId, turn);
    return turn;
  }

  private markTurnStreaming(
    turnId: string,
    sessionId: string,
    timestamp: string,
    actor?: Turn["actor"]
  ): Turn {
    const existing = this.turns.get(turnId);
    const turn = this.upsertTurnRecord({
      turnId,
      sessionId,
      status: existing?.status === "completed" ? "completed" : "streaming",
      finishReason: existing?.finishReason,
      startedAt: existing?.startedAt ?? timestamp,
      completedAt: existing?.completedAt,
      actor: existing?.actor ?? actor,
      messageIds: existing?.messageIds,
      toolCallIds: existing?.toolCallIds,
      terminalIds: existing?.terminalIds,
      approvalRequestIds: existing?.approvalRequestIds
    });
    this.upsertSessionRecord({
      sessionId,
      lastTurnId: turnId,
      updatedAt: timestamp
    });
    return turn;
  }

  private appendTurnCollection(
    turnId: string,
    key: "messageIds" | "toolCallIds" | "terminalIds" | "approvalRequestIds",
    valueId: string,
    timestamp: string
  ): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn[key].includes(valueId)) {
      return;
    }
    this.upsertTurnRecord({
      turnId,
      sessionId: turn.sessionId,
      status: turn.status,
      finishReason: turn.finishReason,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      actor: turn.actor,
      messageIds: key === "messageIds" ? [...turn.messageIds, valueId] : turn.messageIds,
      toolCallIds: key === "toolCallIds" ? [...turn.toolCallIds, valueId] : turn.toolCallIds,
      terminalIds: key === "terminalIds" ? [...turn.terminalIds, valueId] : turn.terminalIds,
      approvalRequestIds:
        key === "approvalRequestIds"
          ? [...turn.approvalRequestIds, valueId]
          : turn.approvalRequestIds
    });
    this.upsertSessionRecord({
      sessionId: turn.sessionId,
      lastTurnId: turnId,
      updatedAt: timestamp
    });
  }

  private removeSessionArtifacts(sessionId: string): void {
    for (const [relationId, relation] of this.sessionRelations.entries()) {
      if (
        relation.parentSessionId === sessionId ||
        relation.childSessionId === sessionId
      ) {
        this.sessionRelations.delete(relationId);
      }
    }

    for (const [turnId, turn] of this.turns.entries()) {
      if (turn.sessionId !== sessionId) {
        continue;
      }

      this.turns.delete(turnId);
      for (const messageId of turn.messageIds) {
        for (const [blockId, block] of this.messageBlocks.entries()) {
          if (block.messageId === messageId) {
            this.messageBlocks.delete(blockId);
          }
        }
      }
      for (const toolCallId of turn.toolCallIds) {
        this.toolCalls.delete(toolCallId);
      }
      for (const terminalId of turn.terminalIds) {
        this.terminalStreams.delete(terminalId);
      }
      for (const requestId of turn.approvalRequestIds) {
        this.approvalRequests.delete(requestId);
      }
    }
  }

  private syncParticipantState(conversationId: string, agentId: string): AgentParticipant {
    const conversation = this.requireConversation(conversationId);
    const participantId = participantIdFor(conversationId, agentId);
    const existing = this.participants.get(participantId);
    const binding = this.bindings.get(agentId);
    const participant = parseAgentParticipant({
      participantId,
      conversationId,
      agentId,
      role:
        existing?.role ??
        (conversation.participantAgentIds[0] === agentId ? "primary" : "secondary"),
      capabilities: existing?.capabilities ?? binding?.descriptor.capabilities ?? [],
      activeSessionIds: this.getActiveSessionIdsForParticipant(conversationId, agentId),
      metadata: existing?.metadata
    });
    this.participants.set(participant.participantId, participant);
    return participant;
  }

  private getActiveSessionIdsForParticipant(
    conversationId: string,
    agentId: string
  ): string[] {
    return this.sessionManager
      .listSessions({
        conversationId,
        includeArchived: true
      })
      .filter((session) => session.agentId === agentId && !session.archivedAt)
      .map((session) => session.sessionId);
  }

  private requireSession(sessionId: string): ChatSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  private requireBinding(agentId: string): WorkbenchAgentBinding {
    const binding = this.bindings.get(agentId);
    if (!binding) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return binding;
  }

  private assertAgentExists(agentId: string): void {
    this.requireBinding(agentId);
  }

  private toSharedEnvelope(envelope: RuntimeEventEnvelope): EventEnvelope {
    return {
      eventId: envelope.eventId,
      cursor: envelope.cursor,
      occurredAt: envelope.occurredAt,
      event: envelope.event
    };
  }
}
