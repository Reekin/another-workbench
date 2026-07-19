import { DomainReplica } from "@another-workbench/core";
import type {
  AgentParticipant,
  ChatSession,
  Command,
  Conversation,
  DomainSnapshot,
  RuntimeEvent,
  SessionRelation,
  SessionRelationType
} from "@another-workbench/shared";
import {
  parseChatSession,
  parseAgentParticipant,
  parseConversation,
  parseSessionRelation
} from "@another-workbench/shared";
import type { SessionRelationIndex } from "./session-index.js";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import { buildLocalEchoMessageText } from "./attachment-inputs.js";
import type { WorkbenchSessionListOptions } from "./runtime-types.js";

type Clock = () => string;
type IdFactory = () => string;

export type DomainServiceOptions = {
  assertEngineRegistered: (engineId: string) => void;
  resolveEngineCapabilities: (engineId: string) => readonly string[];
  publishRuntimeEvent: (event: RuntimeEvent) => void;
  markSessionUnreadCompleted?: (sessionId: string) => void;
  now?: Clock;
  createRelationId?: IdFactory;
  createSessionId?: IdFactory;
};

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const addUnique = (items: readonly string[], value: string): string[] =>
  items.includes(value) ? [...items] : [...items, value];

const withConversationSession = (
  conversation: Conversation | undefined,
  input: {
    conversationId: string;
    sessionId: string;
    engineId: string;
    workspaceId?: string;
    timestamp: string;
  }
): Conversation =>
  parseConversation({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId ?? conversation?.workspaceId,
    participantEngineIds: addUnique(
      conversation?.participantEngineIds ?? [],
      input.engineId
    ),
    activeSessionId: input.sessionId,
    sessionIds: addUnique(conversation?.sessionIds ?? [], input.sessionId),
    createdAt: conversation?.createdAt ?? input.timestamp,
    updatedAt: input.timestamp,
    archivedAt: conversation?.archivedAt,
    metadata: conversation?.metadata
  });

const participantIdFor = (conversationId: string, engineId: string): string =>
  `participant-${conversationId}-${engineId}`;

export class DomainService {
  private readonly assertEngineRegistered: (engineId: string) => void;
  private readonly resolveEngineCapabilities: (engineId: string) => readonly string[];
  private readonly publishRuntimeEvent: (event: RuntimeEvent) => void;
  private readonly markSessionUnreadCompleted?: (sessionId: string) => void;
  private readonly now: Clock;
  private readonly createRelationId: IdFactory;
  private readonly createSessionId: IdFactory;
  private readonly domainReplica: DomainReplica;

  public constructor(options: DomainServiceOptions) {
    this.assertEngineRegistered = options.assertEngineRegistered;
    this.resolveEngineCapabilities = options.resolveEngineCapabilities;
    this.publishRuntimeEvent = options.publishRuntimeEvent;
    this.markSessionUnreadCompleted = options.markSessionUnreadCompleted;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createRelationId = options.createRelationId ?? (() => createOpaqueId("relation"));
    this.createSessionId = options.createSessionId ?? (() => createOpaqueId("session"));
    this.domainReplica = new DomainReplica({
      now: this.now
    });
  }

  public hydrateDiscoveredSession(
    snapshot: HydratedSessionSnapshot,
    input: {
      relatedIndexRelations?: SessionRelationIndex[];
    } = {}
  ): ChatSession {
    const existingConversation = this.domainReplica.getConversation(
      snapshot.conversation.conversationId
    );
    const relatedIndexRelations = (input.relatedIndexRelations ?? []).map(
      (relation) => ({
        relationId: `${relation.parentSessionId}:${relation.childSessionId}:${relation.relationType}`,
        parentSessionId: relation.parentSessionId,
        childSessionId: relation.childSessionId,
        relationType: relation.relationType,
        sourceTurnId: relation.sourceTurnId,
        createdAt: relation.createdAt
      })
    );
    this.domainReplica.mergeSnapshot(
      {
        conversations: [
          withConversationSession(
            parseConversation({
              ...existingConversation,
              ...snapshot.conversation
            }),
            {
              conversationId: snapshot.conversation.conversationId,
              sessionId: snapshot.session.sessionId,
              engineId: snapshot.session.engineId,
              workspaceId: snapshot.conversation.workspaceId,
              timestamp: snapshot.session.updatedAt
            }
          )
        ],
        sessions: [snapshot.session],
        turns: snapshot.turns,
        messageBlocks: snapshot.messageBlocks,
        toolCalls: snapshot.toolCalls,
        terminalStreams: snapshot.terminalStreams,
        approvalRequests: [],
        runtimeInteractions: [],
        participants: [],
        threadGoals: [],
        sessionRelations: [
          ...snapshot.sessionRelations,
          ...relatedIndexRelations
        ]
      },
      {
        scope: {
          sessionId: snapshot.session.sessionId
        }
      }
    );

    const session = this.requireSession(snapshot.session.sessionId);
    this.ensureParticipantForSession(session);

    return session;
  }

  public listSessions(options: WorkbenchSessionListOptions = {}): ChatSession[] {
    return this.domainReplica.listSessions(options);
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.domainReplica.getSession(sessionId);
  }

  public requireSession(sessionId: string): ChatSession {
    const session = this.domainReplica.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  public getConversation(conversationId: string): Conversation | undefined {
    return this.domainReplica.getConversation(conversationId);
  }

  public requireConversation(conversationId: string): Conversation {
    const conversation = this.domainReplica.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  public createSession(input: {
    conversationId: string;
    engineId: string;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }): ChatSession {
    this.assertEngineRegistered(input.engineId);
    const session = this.createSessionRecord({
      conversationId: input.conversationId,
      engineId: input.engineId,
      metadata: input.metadata
    });

    this.primeConversationForSession(session, input.workspaceId);
    this.ensureParticipantForSession(session);
    this.commitRuntimeEvent({
      type: "session.created",
      conversationId: input.conversationId,
      sessionId: session.sessionId,
      engineId: session.engineId,
      status: session.status
    });
    this.publishConversationUpdated({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      activeSessionId: session.sessionId
    });

    return session;
  }

  public resumeSession(sessionId: string): ChatSession {
    const session = this.resumeSessionRecord(sessionId);
    this.primeConversationForSession(session);
    this.ensureParticipantForSession(session);
    this.commitRuntimeEvent({
      type: "session.updated",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      status: session.status
    });
    this.publishConversationUpdated({
      conversationId: session.conversationId,
      activeSessionId: session.sessionId
    });
    return session;
  }

  public archiveSession(sessionId: string): ChatSession {
    const session = this.requireSession(sessionId);
    const archivedAt = this.now();
    this.commitRuntimeEvent({
      type: "session.archived",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      archivedAt
    });
    this.publishConversationUpdated({
      conversationId: session.conversationId
    });
    return this.requireSession(sessionId);
  }

  public updateSessionTitle(input: {
    sessionId: string;
    title: string;
  }): ChatSession {
    const session = this.requireSession(input.sessionId);
    const title = input.title.trim();
    if (!title || session.title === title) {
      return session;
    }

    this.commitRuntimeEvent({
      type: "session.updated",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      status: session.status,
      title
    });
    return this.requireSession(session.sessionId);
  }

  public forkSession(input: {
    sessionId: string;
    fromTurnId?: string;
  }): {
    parentSession: ChatSession;
    childSession: ChatSession;
    relation: SessionRelation;
  } {
    const parentSession = this.requireSession(input.sessionId);
    const timestamp = this.now();
    const childSession = this.createSessionRecord({
      conversationId: parentSession.conversationId,
      engineId: parentSession.engineId,
      metadata: parentSession.metadata
    });
    const relation = parseSessionRelation({
      relationId: this.createRelationId(),
      parentSessionId: parentSession.sessionId,
      childSessionId: childSession.sessionId,
      relationType: "fork",
      sourceTurnId: input.fromTurnId,
      createdAt: timestamp
    });

    this.primeConversationForSession(childSession);
    this.ensureParticipantForSession(childSession);
    this.commitRuntimeEvent({
      type: "session.created",
      conversationId: childSession.conversationId,
      sessionId: childSession.sessionId,
      engineId: childSession.engineId,
      status: childSession.status,
      relation
    });
    this.publishConversationUpdated({
      conversationId: childSession.conversationId,
      activeSessionId: childSession.sessionId
    });

    return {
      parentSession,
      childSession,
      relation
    };
  }

  public createRelatedSession(input: {
    parentSessionId: string;
    engineId: string;
    relationType: SessionRelationType;
    sourceTurnId?: string;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }): {
    parentSession: ChatSession;
    childSession: ChatSession;
    relation: SessionRelation;
  } {
    const parentSession = this.requireSession(input.parentSessionId);
    const timestamp = this.now();
    const childSession = this.createSessionRecord({
      conversationId: parentSession.conversationId,
      engineId: input.engineId,
      metadata: input.metadata
    });
    const relation = parseSessionRelation({
      relationId: this.createRelationId(),
      parentSessionId: parentSession.sessionId,
      childSessionId: childSession.sessionId,
      relationType: input.relationType,
      sourceTurnId: input.sourceTurnId,
      createdAt: timestamp
    });

    this.primeConversationForSession(childSession, input.workspaceId);
    this.ensureParticipantForSession(childSession);
    this.commitRuntimeEvent({
      type: "session.created",
      conversationId: childSession.conversationId,
      sessionId: childSession.sessionId,
      engineId: childSession.engineId,
      status: childSession.status,
      relation
    });
    this.publishConversationUpdated({
      conversationId: childSession.conversationId,
      workspaceId: input.workspaceId,
      activeSessionId: childSession.sessionId
    });

    return {
      parentSession,
      childSession,
      relation
    };
  }

  public disposeSession(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    this.commitRuntimeEvent({
      type: "session.disposed",
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      disposedAt: this.now()
    });
    this.publishConversationUpdated({
      conversationId: session.conversationId
    });
    return true;
  }

  public commitAcceptedUserMessage(
    command: Extract<Command, { type: "sendUserMessage" }>,
    turnId: string
  ): void {
    const renderedContent = buildLocalEchoMessageText(
      command.content,
      command.attachments
    );
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
    if (renderedContent.length > 0) {
      this.commitRuntimeEvent({
        type: "message.delta",
        sessionId: command.sessionId,
        turnId,
        messageId: command.messageId,
        delta: renderedContent
      });
    }
    this.commitRuntimeEvent({
      type: "message.completed",
      sessionId: command.sessionId,
      turnId,
      messageId: command.messageId,
      finalText: renderedContent
    });
  }

  public commitSteerUserMessage(
    command: Extract<Command, { type: "steerTurn" }>
  ): void {
    const renderedContent = buildLocalEchoMessageText(
      command.content,
      command.attachments
    );
    this.commitRuntimeEvent({
      type: "message.started",
      sessionId: command.sessionId,
      turnId: command.turnId,
      messageId: command.messageId,
      role: "user"
    });
    if (renderedContent.length > 0) {
      this.commitRuntimeEvent({
        type: "message.delta",
        sessionId: command.sessionId,
        turnId: command.turnId,
        messageId: command.messageId,
        delta: renderedContent
      });
    }
    this.commitRuntimeEvent({
      type: "message.completed",
      sessionId: command.sessionId,
      turnId: command.turnId,
      messageId: command.messageId,
      finalText: renderedContent
    });
  }

  public resolveConversationIdForSession(sessionId: string): string | undefined {
    return this.domainReplica.resolveConversationIdBySessionId(sessionId);
  }

  public getSnapshot(): DomainSnapshot {
    return this.domainReplica.getSnapshot();
  }

  public ingestRuntimeEvent(event: RuntimeEvent, occurredAt?: string): void {
    this.applyRuntimeEvent(event, occurredAt);
  }

  public commitRuntimeEvent(event: RuntimeEvent): void {
    this.applyRuntimeEvent(event);
    this.publishRuntimeEvent(event);
  }

  private applyRuntimeEvent(event: RuntimeEvent, occurredAt?: string): void {
    this.domainReplica.apply(event, occurredAt);
    if (event.type === "turn.completed") {
      this.markSessionUnreadCompleted?.(event.sessionId);
    }
  }

  private createSessionRecord(input: {
    conversationId: string;
    engineId: string;
    metadata?: Record<string, unknown>;
  }): ChatSession {
    const timestamp = this.now();
    return parseChatSession({
      sessionId: this.createSessionId(),
      conversationId: input.conversationId,
      engineId: input.engineId,
      status: "idle",
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  private resumeSessionRecord(sessionId: string): ChatSession {
    const existingSession = this.requireSession(sessionId);
    const resumedSession = parseChatSession({
      ...existingSession,
      archivedAt: undefined,
      status:
        existingSession.status === "completed" ? "idle" : existingSession.status,
      updatedAt: this.now()
    });
    this.domainReplica.upsertSession(resumedSession);
    return resumedSession;
  }

  private primeConversationForSession(
    session: ChatSession,
    workspaceId?: string
  ): Conversation {
    const conversation = withConversationSession(
      this.domainReplica.getConversation(session.conversationId),
      {
        conversationId: session.conversationId,
        sessionId: session.sessionId,
        engineId: session.engineId,
        workspaceId,
        timestamp: session.updatedAt
      }
    );
    this.domainReplica.upsertConversation(conversation);
    this.domainReplica.upsertSession(session);
    return conversation;
  }

  private ensureParticipantForSession(session: ChatSession): AgentParticipant {
    const conversation = this.requireConversation(session.conversationId);
    this.assertEngineRegistered(session.engineId);
    const participantId = participantIdFor(session.conversationId, session.engineId);
    const existing = this.domainReplica.getParticipant(participantId);
    const role =
      existing?.role ??
      (conversation.participantEngineIds[0] === session.engineId ? "primary" : "secondary");
    const participant = parseAgentParticipant({
      participantId,
      conversationId: session.conversationId,
      engineId: session.engineId,
      role,
      capabilities: [...this.resolveEngineCapabilities(session.engineId)],
      activeSessionIds: this.getActiveSessionIdsForParticipant(
        session.conversationId,
        session.engineId
      ),
      metadata: existing?.metadata
    });

    this.commitRuntimeEvent({
      type: "participant.updated",
      conversationId: session.conversationId,
      participantId: participant.participantId,
      engineId: participant.engineId,
      role: participant.role,
      capabilities: participant.capabilities
    });

    return participant;
  }

  private publishConversationUpdated(input: {
    conversationId: string;
    workspaceId?: string;
    activeSessionId?: string;
  }): Conversation {
    const conversation = this.domainReplica.getConversation(input.conversationId);
    const participantIds = this.domainReplica
      .listParticipants({ conversationId: input.conversationId })
      .map((participant) => participant.participantId);

    this.commitRuntimeEvent({
      type: "conversation.updated",
      conversationId: input.conversationId,
      workspaceId: input.workspaceId ?? conversation?.workspaceId,
      activeSessionId: input.activeSessionId ?? conversation?.activeSessionId,
      participantIds
    });

    return this.requireConversation(input.conversationId);
  }

  private getActiveSessionIdsForParticipant(
    conversationId: string,
    engineId: string
  ): string[] {
    return this.domainReplica
      .listSessions({
        conversationId,
        engineId,
        includeArchived: true
      })
      .filter((session) => !session.archivedAt)
      .map((session) => session.sessionId);
  }
}
