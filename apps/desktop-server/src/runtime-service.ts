import { RuntimeEventBus, type RuntimeEventEnvelope, type RuntimeEventFilter, type RuntimeEventReplayInput } from "@another-workbench/core";
import type {
  AgentDescriptor,
  ChatSession,
  Command,
  CommandEnvelope,
  DomainSnapshot,
  EventEnvelope,
  ProviderSessionHandle
} from "@another-workbench/shared";
import type {
  SessionIndexStore,
  SessionRelationIndex
} from "./session-index.js";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import { DomainService } from "./domain-service.js";
import { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import { SessionIndexSyncService } from "./session-index-sync-service.js";
import type {
  AgentSelectionInput,
  CommandReceipt,
  SnapshotResult,
  WorkbenchAgentBinding,
  WorkbenchSessionListOptions
} from "./runtime-types.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

type Clock = () => string;
type IdFactory = () => string;

export type {
  AgentSelectionInput,
  CommandReceipt,
  SnapshotResult,
  WorkbenchAgentBinding,
  WorkbenchSessionListOptions
} from "./runtime-types.js";

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

export class WorkbenchRuntimeService {
  private readonly workspaceRegistry?: WorkspaceRegistryService;
  private readonly sessionIndexStore?: SessionIndexStore;
  private readonly eventBus: RuntimeEventBus;
  private readonly domainService: DomainService;
  private readonly runtimeOrchestrator: RuntimeOrchestrator;

  public constructor(options: WorkbenchRuntimeServiceOptions = {}) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.sessionIndexStore = options.sessionIndexStore;
    this.domainService = new DomainService({
      now: options.now,
      createRelationId: options.createRelationId,
      createSessionId: options.createSessionId,
      resolveAgentDescriptor: (agentId) =>
        this.runtimeOrchestrator?.getAgentDescriptor(agentId),
      publishRuntimeEvent: (event) => {
        this.eventBus.publish(event);
      },
      markSessionUnreadCompleted: (sessionId) => {
        void this.sessionIndexStore?.markSessionUnreadCompleted(sessionId);
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
        this.eventBus.publish(event);
      },
      agents: options.agents,
      agentBindings: options.agentBindings,
      now: options.now,
      createConversationId: options.createConversationId
    });
  }

  public registerAgent(agent: AgentDescriptor): void {
    this.runtimeOrchestrator.registerAgent(agent);
  }

  public registerAgentBinding(binding: WorkbenchAgentBinding): void {
    this.runtimeOrchestrator.registerAgentBinding(binding);
  }

  public listAgents(): AgentDescriptor[] {
    return this.runtimeOrchestrator.listAgents();
  }

  public selectAgent(input: AgentSelectionInput): { selectedAgentId: string } {
    return this.runtimeOrchestrator.selectAgent(input);
  }

  public getSelectedAgentId(): string | undefined {
    return this.runtimeOrchestrator.getSelectedAgentId();
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

  public async createSession(
    command: Extract<Command, { type: "createSession" }>
  ): Promise<ChatSession> {
    return this.runtimeOrchestrator.createSession(command);
  }

  public resolveConversationIdForSession(
    sessionId: string
  ): string | undefined {
    return this.domainService.resolveConversationIdForSession(sessionId);
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
}
