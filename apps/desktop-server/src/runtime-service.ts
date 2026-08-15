import { RuntimeEventBus, type RuntimeEventEnvelope, type RuntimeEventFilter, type RuntimeEventReplayInput } from "@another-workbench/core";
import type {
  ChatSession,
  Command,
  CommandEnvelope,
  DomainSnapshot,
  EngineModelCatalogRpc,
  EventEnvelope,
  ProviderSessionHandle,
  SessionRelationType
} from "@another-workbench/shared";
import type { SessionExecutionProfileInput } from "@another-workbench/shared";
import type {
  SessionIndexStore,
  SessionRelationIndex
} from "./session-index.js";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import { DomainService } from "./domain-service.js";
import { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import { SessionIndexSyncService } from "./session-index-sync-service.js";
import type { SessionTitleGenerator } from "./title-generation-service.js";
import type {
  EngineSelectionInput,
  EventReplayResult,
  CommandReceipt,
  SnapshotResult,
  WorkbenchAgentBinding,
  WorkbenchEngineDescriptor,
  WorkbenchSessionListOptions
} from "./runtime-types.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

type Clock = () => string;
type IdFactory = () => string;

const isSessionBrowserRelevantEvent = (
  event: EventEnvelope["event"]
): boolean => {
  switch (event.type) {
    case "conversation.updated":
      return event.workspaceId !== undefined;
    case "session.created":
    case "session.updated":
    case "session.archived":
    case "session.disposed":
    case "turn.started":
    case "turn.completed":
    case "approval.requested":
    case "interaction.requested":
      return true;
    case "runtime.error":
      return !event.recoverable && Boolean(event.sessionId);
    case "session.context.updated":
    case "message.started":
    case "message.delta":
    case "message.completed":
    case "tool.started":
    case "tool.delta":
    case "tool.completed":
    case "terminal.started":
    case "terminal.output":
    case "terminal.completed":
    case "approval.resolved":
    case "interaction.resolved":
    case "thread.goal.updated":
    case "thread.goal.cleared":
    case "engineExtension.updated":
    case "conversationGraph.updated":
    case "participant.updated":
      return false;
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
};

export type {
  EngineSelectionInput,
  EventReplayResult,
  CommandReceipt,
  SnapshotResult,
  WorkbenchAgentBinding,
  WorkbenchEngineDescriptor,
  WorkbenchSessionListOptions
} from "./runtime-types.js";

export type WorkbenchRuntimeServiceOptions = {
  engines?: WorkbenchEngineDescriptor[];
  agentBindings?: WorkbenchAgentBinding[];
  workspaceRegistry?: WorkspaceRegistryService;
  sessionIndexStore?: SessionIndexStore;
  now?: Clock;
  createConversationId?: IdFactory;
  createRelationId?: IdFactory;
  createSessionId?: IdFactory;
  createEventId?: IdFactory;
  titleGenerator?: SessionTitleGenerator;
};

export class WorkbenchRuntimeService {
  private readonly workspaceRegistry?: WorkspaceRegistryService;
  private readonly sessionIndexStore?: SessionIndexStore;
  private readonly eventBus: RuntimeEventBus;
  private readonly domainService: DomainService;
  private readonly runtimeOrchestrator: RuntimeOrchestrator;
  private sessionBrowserRevision = 0;

  public constructor(options: WorkbenchRuntimeServiceOptions = {}) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.domainService = new DomainService({
      now: options.now,
      createRelationId: options.createRelationId,
      createSessionId: options.createSessionId,
      assertEngineRegistered: (engineId) =>
        this.runtimeOrchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        this.runtimeOrchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: (event) => {
        this.publishRuntimeEvent(event);
      },
      markSessionUnreadCompleted: (sessionId) => {
        void this.markSessionUnreadCompleted(sessionId);
      }
    });
    this.eventBus = new RuntimeEventBus({
      now: options.now,
      createId: options.createEventId,
      resolveConversationIdBySessionId: (sessionId) =>
        this.domainService.resolveConversationIdForSession(sessionId)
    });
    const workspaceSelectionService = new WorkspaceSelectionService({
      workspaceRegistry: this.workspaceRegistry
    });
    const sessionIndexSyncService = new SessionIndexSyncService({
      sessionIndexStore: this.sessionIndexStore,
      resolveSessionRecord: (sessionId) =>
        this.runtimeOrchestrator?.resolveSessionIndexRecord(sessionId)
    });
    this.runtimeOrchestrator = new RuntimeOrchestrator({
      domainService: this.domainService,
      sessionIndexSyncService,
      workspaceSelectionService,
      publishRuntimeEvent: (event) => {
        this.publishRuntimeEvent(event);
      },
      engines: options.engines,
      agentBindings: options.agentBindings,
      titleGenerator: options.titleGenerator,
      now: options.now,
      createConversationId: options.createConversationId
    });
  }

  public registerEngine(engine: WorkbenchEngineDescriptor): void {
    this.runtimeOrchestrator.registerEngine(engine);
  }

  public registerAgentBinding(binding: WorkbenchAgentBinding): void {
    this.runtimeOrchestrator.registerAgentBinding(binding);
  }

  public selectEngine(input: EngineSelectionInput): { selectedEngineId: string } {
    return this.runtimeOrchestrator.selectEngine(input);
  }

  public getSelectedEngineId(): string | undefined {
    return this.runtimeOrchestrator.getSelectedEngineId();
  }

  public async listEngineModels(engineId: string): Promise<EngineModelCatalogRpc> {
    return this.runtimeOrchestrator.listEngineModels(engineId);
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
    return this.runtimeOrchestrator.hydrateDiscoveredSession(snapshot, input);
  }

  public async executeCommand(input: CommandEnvelope): Promise<CommandReceipt> {
    return this.runtimeOrchestrator.executeCommand(input);
  }

  public listSessions(options: WorkbenchSessionListOptions = {}): ChatSession[] {
    return this.domainService.listSessions(options);
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.domainService.getSession(sessionId);
  }

  public async createSession(
    command: Extract<Command, { type: "createSession" }>
  ): Promise<ChatSession> {
    return this.runtimeOrchestrator.createSession(command);
  }

  public async createRelatedSession(command: {
    parentSessionId: string;
    engineId: string;
    relationType: SessionRelationType;
    sourceTurnId?: string;
    sessionProfile?: SessionExecutionProfileInput;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }): Promise<ChatSession> {
    return this.runtimeOrchestrator.createRelatedSession(command);
  }

  public resolveConversationIdForSession(
    sessionId: string
  ): string | undefined {
    return this.domainService.resolveConversationIdForSession(sessionId);
  }

  private async markSessionUnreadCompleted(sessionId: string): Promise<void> {
    if (!this.sessionIndexStore) {
      return;
    }
    if (this.workspaceRegistry) {
      await this.workspaceRegistry.ready();
      if (this.workspaceRegistry.getState().lastActiveSessionId === sessionId) {
        await this.sessionIndexStore.markSessionRead(sessionId);
        return;
      }
    }
    await this.sessionIndexStore.markSessionUnreadCompleted(sessionId);
  }

  public resolveProviderSessionHandle(
    sessionId: string
  ): ProviderSessionHandle | undefined {
    return this.runtimeOrchestrator.resolveProviderSessionHandle(sessionId);
  }

  public getSnapshot(): DomainSnapshot {
    return this.domainService.getSnapshot();
  }

  public applyRuntimeEvent(
    event: EventEnvelope["event"],
    occurredAt?: string
  ): void {
    this.domainService.ingestRuntimeEvent(event, occurredAt);
    this.advanceSessionBrowserRevision(event);
  }

  public getSnapshotResult(): SnapshotResult {
    return {
      snapshot: this.getSnapshot(),
      cursor: this.eventBus.getLatestCursor()
    };
  }

  public getRevision(): string {
    return this.eventBus.getLatestCursor() ?? "initial";
  }

  public getSessionBrowserRevision(): number {
    return this.sessionBrowserRevision;
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
    return this.replayResult(input).envelopes;
  }

  public replayResult(input: RuntimeEventReplayInput = {}): EventReplayResult {
    const result = this.eventBus.replayResult(input);
    return {
      ...result,
      envelopes: result.envelopes.map((envelope) => this.toSharedEnvelope(envelope))
    };
  }

  public async dispose(): Promise<void> {
    await this.runtimeOrchestrator.dispose();
  }

  private toSharedEnvelope(envelope: RuntimeEventEnvelope): EventEnvelope {
    return {
      eventId: envelope.eventId,
      cursor: envelope.cursor,
      occurredAt: envelope.occurredAt,
      event: envelope.event
    };
  }

  private publishRuntimeEvent(event: EventEnvelope["event"]): void {
    this.advanceSessionBrowserRevision(event);
    this.eventBus.publish(event);
  }

  private advanceSessionBrowserRevision(event: EventEnvelope["event"]): void {
    if (isSessionBrowserRelevantEvent(event)) {
      this.sessionBrowserRevision += 1;
    }
  }
}
