import type {
  ProviderSessionHandle,
  Command,
  SessionExecutionProfile,
  SessionExecutionProfileInput,
  SessionRelationType
} from "@another-workbench/shared";
import { parseCommandEnvelope } from "@another-workbench/shared";
import type { CommandEnvelope, EventEnvelope } from "@another-workbench/shared";
import {
  resolveSessionExecutionProfile,
  writeSessionExecutionProfile
} from "@another-workbench/shared";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import { DomainService } from "./domain-service.js";
import { SessionIndexSyncService } from "./session-index-sync-service.js";
import type { SessionRelationIndex } from "./session-index.js";
import {
  type EngineSelectionInput,
  type CommandReceipt,
  type WorkbenchAgentBinding,
  type WorkbenchEngineDescriptor
} from "./runtime-types.js";
import type { SessionTitleGenerator } from "./title-generation-service.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";

type Clock = () => string;
type IdFactory = () => string;
type SessionRelationSyncInput = Parameters<SessionIndexSyncService["syncRelation"]>[0];

export type RuntimeOrchestratorOptions = {
  domainService: DomainService;
  sessionIndexSyncService: SessionIndexSyncService;
  workspaceSelectionService: WorkspaceSelectionService;
  publishRuntimeEvent: (event: EventEnvelope["event"]) => void;
  engines?: WorkbenchEngineDescriptor[];
  agentBindings?: WorkbenchAgentBinding[];
  titleGenerator?: SessionTitleGenerator;
  now?: Clock;
  createConversationId?: IdFactory;
};

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

export class RuntimeOrchestrator {
  private readonly bindings = new Map<string, WorkbenchAgentBinding>();
  private readonly engineSelections = new Map<string, Record<string, unknown> | undefined>();
  private readonly adapterUnsubscribeByEngineId = new Map<string, () => void>();
  private readonly readyEngineIds = new Set<string>();
  private readonly domainService: DomainService;
  private readonly sessionIndexSyncService: SessionIndexSyncService;
  private readonly workspaceSelectionService: WorkspaceSelectionService;
  private readonly publishRuntimeEvent: (event: EventEnvelope["event"]) => void;
  private readonly titleGenerator: SessionTitleGenerator | undefined;
  private readonly titleGenerationSessionIds = new Set<string>();
  private readonly now: Clock;
  private readonly createConversationId: IdFactory;
  private readonly adapterEventQueue: EventEnvelope[] = [];
  private readonly pendingSessionIndexSyncIds = new Set<string>();
  private readonly pendingRelationSyncs = new Map<string, SessionRelationSyncInput>();
  private adapterEventQueueReadIndex = 0;
  private isDrainingAdapterEvents = false;
  private indexSyncPump: Promise<void> | undefined;
  private selectedEngineId: string | undefined;

  public constructor(options: RuntimeOrchestratorOptions) {
    this.domainService = options.domainService;
    this.sessionIndexSyncService = options.sessionIndexSyncService;
    this.workspaceSelectionService = options.workspaceSelectionService;
    this.publishRuntimeEvent = options.publishRuntimeEvent;
    this.titleGenerator = options.titleGenerator;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createConversationId =
      options.createConversationId ?? (() => createOpaqueId("conversation"));

    for (const engine of options.engines ?? []) {
      this.registerEngine(engine);
    }
    for (const binding of options.agentBindings ?? []) {
      this.registerAgentBinding(binding);
    }
    this.selectedEngineId =
      options.agentBindings?.[0]?.descriptor.engineId ??
      options.engines?.[0]?.engineId;
  }

  public registerEngine(engine: WorkbenchEngineDescriptor): void {
    const existing = this.bindings.get(engine.engineId);
    this.bindings.set(engine.engineId, {
      descriptor: {
        ...engine,
        capabilities: [...engine.capabilities]
      },
      adapter: existing?.adapter,
      runtimeConfig: existing?.runtimeConfig,
      providerKind: existing?.providerKind,
      resolveProviderSessionId: existing?.resolveProviderSessionId
    });
    if (!this.selectedEngineId) {
      this.selectedEngineId = engine.engineId;
    }
  }

  public registerAgentBinding(binding: WorkbenchAgentBinding): void {
    this.bindings.set(binding.descriptor.engineId, {
      descriptor: {
        ...binding.descriptor,
        capabilities: [...binding.descriptor.capabilities]
      },
      adapter: binding.adapter,
      runtimeConfig: binding.runtimeConfig,
      providerKind: binding.providerKind,
      resolveProviderSessionId: binding.resolveProviderSessionId
    });
    if (!this.selectedEngineId) {
      this.selectedEngineId = binding.descriptor.engineId;
    }
  }

  public getEngineCapabilities(engineId: string): string[] {
    const binding = this.requireBinding(engineId);
    return [...binding.sharedCapabilities ?? binding.descriptor.capabilities];
  }

  public selectEngine(input: EngineSelectionInput): { selectedEngineId: string } {
    this.assertEngineRegistered(input.engineId);
    this.selectedEngineId = input.engineId;
    this.engineSelections.set(
      input.engineId,
      input.config ? { ...input.config } : undefined
    );
    return {
      selectedEngineId: input.engineId
    };
  }

  public getSelectedEngineId(): string | undefined {
    return this.selectedEngineId;
  }

  public hydrateDiscoveredSession(
    snapshot: HydratedSessionSnapshot,
    input: {
      relatedIndexRelations?: SessionRelationIndex[];
    } = {}
  ) {
    const session = this.domainService.hydrateDiscoveredSession(snapshot, input);
    this.bindRuntime(session.sessionId);
    return session;
  }

  public async executeCommand(input: CommandEnvelope): Promise<CommandReceipt> {
    const envelope = parseCommandEnvelope(input);
    switch (envelope.command.type) {
      case "initialize":
        if (this.selectedEngineId) {
          await this.ensureAdapterReady(this.selectedEngineId);
        }
        return this.accept(envelope, true);
      case "listSessions":
        return this.accept(envelope, true);
      case "createSession":
        await this.createSession(envelope.command);
        return this.accept(envelope, true);
      case "resumeSession":
        await this.resumeSession(envelope.command.sessionId);
        return this.accept(envelope, true);
      case "archiveSession":
        await this.archiveSession(envelope.command.sessionId);
        return this.accept(envelope, true);
      case "forkSession":
        await this.forkSession(envelope.command.sessionId, envelope.command.fromTurnId);
        return this.accept(envelope, true);
      case "disposeSession":
        await this.disposeSession(envelope.command.sessionId);
        return this.accept(envelope, true);
      case "sendUserMessage": {
        const session = this.domainService.requireSession(envelope.command.sessionId);
        const shouldGenerateTitle = this.shouldGenerateTitleFromFirstUserMessage(
          envelope.command
        );
        this.domainService.commitLocalUserMessage(envelope.command);
        const receipt = await this.forwardSessionCommand(envelope.command.sessionId, envelope, {
          before: () => {
            this.domainService.commitRuntimeEvent({
              type: "session.updated",
              conversationId: session.conversationId,
              sessionId: session.sessionId,
              status: "running"
            });
          }
        });
        if (!receipt.accepted) {
          this.domainService.commitRuntimeEvent({
            type: "session.updated",
            conversationId: session.conversationId,
            sessionId: session.sessionId,
            status: "idle"
          });
        }
        if (shouldGenerateTitle && receipt.accepted) {
          this.scheduleTitleGeneration(envelope.command);
        }
        return receipt;
      }
      case "steerTurn": {
        const session = this.domainService.requireSession(envelope.command.sessionId);
        this.domainService.commitSteerUserMessage(envelope.command);
        const receipt = await this.forwardSessionCommand(envelope.command.sessionId, envelope, {
          before: () => {
            this.domainService.commitRuntimeEvent({
              type: "session.updated",
              conversationId: session.conversationId,
              sessionId: session.sessionId,
              status: "running"
            });
          }
        });
        return receipt;
      }
      case "interruptTurn":
        return this.forwardSessionCommand(envelope.command.sessionId, envelope);
      case "setThreadGoal":
      case "clearThreadGoal":
        return this.forwardSessionCommand(envelope.command.sessionId, envelope);
      case "respondApproval":
      case "respondInteraction":
        return this.forwardSessionCommand(envelope.command.sessionId, envelope);
      default: {
        const exhaustive: never = envelope.command;
        return exhaustive;
      }
    }
  }

  public async createSession(command: {
    conversationId?: string;
    engineId: string;
    sessionProfile?: SessionExecutionProfileInput;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }) {
    const conversationId = command.conversationId ?? this.createConversationId();
    const sessionProfile: SessionExecutionProfile = {
      engineId: command.engineId,
      ...command.sessionProfile
    };
    this.assertEngineRegistered(sessionProfile.engineId);
    const session = this.domainService.createSession({
      conversationId,
      engineId: sessionProfile.engineId,
      metadata: writeSessionExecutionProfile(command.metadata, sessionProfile),
      workspaceId: command.workspaceId
    });
    this.bindRuntime(session.sessionId);
    const conversation = this.domainService.requireConversation(conversationId);
    await this.sessionIndexSyncService.syncSession(session.sessionId);
    await this.workspaceSelectionService.activateSelection({
      workspaceId: conversation.workspaceId,
      sessionId: session.sessionId
    });
    return session;
  }

  public async createRelatedSession(command: {
    parentSessionId: string;
    engineId: string;
    relationType: SessionRelationType;
    sourceTurnId?: string;
    sessionProfile?: SessionExecutionProfileInput;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }) {
    const sessionProfile: SessionExecutionProfile = {
      engineId: command.engineId,
      ...command.sessionProfile
    };
    this.assertEngineRegistered(sessionProfile.engineId);
    const { parentSession, childSession, relation } =
      this.domainService.createRelatedSession({
        parentSessionId: command.parentSessionId,
        engineId: sessionProfile.engineId,
        relationType: command.relationType,
        sourceTurnId: command.sourceTurnId,
        metadata: writeSessionExecutionProfile(command.metadata, sessionProfile),
        workspaceId: command.workspaceId
      });
    this.bindRuntime(childSession.sessionId);
    const conversation = this.domainService.requireConversation(
      childSession.conversationId
    );
    await this.sessionIndexSyncService.syncSession(childSession.sessionId);
    if (conversation.workspaceId) {
      await this.sessionIndexSyncService.syncRelation({
        workspaceId: conversation.workspaceId,
        parentSessionId: parentSession.sessionId,
        childSessionId: childSession.sessionId,
        relationType: relation.relationType,
        sourceTurnId: relation.sourceTurnId,
        createdAt: relation.createdAt
      });
    }
    return childSession;
  }

  public async resumeSession(sessionId: string) {
    const session = this.domainService.resumeSession(sessionId);
    this.assertEngineRegistered(this.resolveSessionEngineId(session));
    const conversation = this.domainService.requireConversation(session.conversationId);
    await this.sessionIndexSyncService.syncSession(session.sessionId);
    await this.workspaceSelectionService.activateSelection({
      workspaceId: conversation.workspaceId,
      sessionId: session.sessionId
    });
    return session;
  }

  public async archiveSession(sessionId: string) {
    const session = this.domainService.archiveSession(sessionId);
    await this.sessionIndexSyncService.syncSession(session.sessionId);
    return session;
  }

  public async forkSession(sessionId: string, fromTurnId?: string) {
    const { parentSession, childSession, relation } = this.domainService.forkSession({
      sessionId,
      fromTurnId
    });
    this.bindRuntime(childSession.sessionId);
    const conversation = this.domainService.requireConversation(childSession.conversationId);
    await this.sessionIndexSyncService.syncSession(childSession.sessionId);
    if (conversation.workspaceId) {
      await this.sessionIndexSyncService.syncRelation({
        workspaceId: conversation.workspaceId,
        parentSessionId: parentSession.sessionId,
        childSessionId: childSession.sessionId,
        relationType: relation.relationType,
        sourceTurnId: relation.sourceTurnId,
        createdAt: relation.createdAt
      });
      await this.workspaceSelectionService.activateSelection({
        workspaceId: conversation.workspaceId,
        sessionId: childSession.sessionId
      });
    }
    return childSession;
  }

  public async disposeSession(sessionId: string): Promise<boolean> {
    return this.domainService.disposeSession(sessionId);
  }

  public async dispose(): Promise<void> {
    for (const unsubscribe of this.adapterUnsubscribeByEngineId.values()) {
      unsubscribe();
    }
    this.adapterUnsubscribeByEngineId.clear();

    for (const binding of this.bindings.values()) {
      await binding.adapter?.dispose();
    }
    await this.drainBackgroundWork();
    this.readyEngineIds.clear();
  }

  public resolveSessionIndexRecord(sessionId: string) {
    const session = this.domainService.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const conversation = this.domainService.getConversation(session.conversationId);
    const engineId = this.resolveSessionEngineId(session);
    const binding = this.bindings.get(engineId);
    const lastCompletedTurnAt = this.resolveLastCompletedTurnAt(sessionId);
    return {
      workspaceId: conversation?.workspaceId,
      session,
      providerKind: binding?.providerKind,
      providerSessionId: binding?.resolveProviderSessionId?.(session.sessionId),
      lastCompletedTurnAt
    };
  }

  private resolveLastCompletedTurnAt(sessionId: string): string | undefined {
    let latestCompletedAt: string | undefined;
    for (const turn of this.domainService.getSnapshot().turns) {
      if (
        turn.sessionId !== sessionId ||
        turn.status !== "completed" ||
        !turn.completedAt
      ) {
        continue;
      }
      if (!latestCompletedAt || turn.completedAt > latestCompletedAt) {
        latestCompletedAt = turn.completedAt;
      }
    }
    return latestCompletedAt;
  }

  public resolveProviderSessionHandle(
    sessionId: string
  ): ProviderSessionHandle | undefined {
    const record = this.resolveSessionIndexRecord(sessionId);
    if (!record?.providerKind || !record.providerSessionId) {
      return undefined;
    }
    return {
      providerKind: record.providerKind,
      providerSessionId: record.providerSessionId
    };
  }

  private shouldGenerateTitleFromFirstUserMessage(
    command: Extract<Command, { type: "sendUserMessage" }>
  ): boolean {
    if (!this.titleGenerator) {
      return false;
    }
    if (this.titleGenerationSessionIds.has(command.sessionId)) {
      return false;
    }
    const session = this.domainService.requireSession(command.sessionId);
    if (session.title?.trim()) {
      return false;
    }
    if (!command.content.trim() && command.attachments.length === 0) {
      return false;
    }
    return !this.domainService
      .getSnapshot()
      .turns.some((turn) => turn.sessionId === command.sessionId);
  }

  private scheduleTitleGeneration(
    command: Extract<Command, { type: "sendUserMessage" }>
  ): void {
    if (!this.titleGenerator) {
      return;
    }
    this.titleGenerationSessionIds.add(command.sessionId);
    void this.generateTitle(command).finally(() => {
      this.titleGenerationSessionIds.delete(command.sessionId);
    });
  }

  private async generateTitle(
    command: Extract<Command, { type: "sendUserMessage" }>
  ): Promise<void> {
    try {
      const title = await this.titleGenerator?.generateTitle({
        content: command.content,
        attachments: command.attachments
      });
      if (!title) {
        return;
      }
      const session = this.domainService.getSession(command.sessionId);
      if (!session || session.title?.trim()) {
        return;
      }
      this.domainService.updateSessionTitle({
        sessionId: command.sessionId,
        title
      });
      await this.sessionIndexSyncService.syncSession(command.sessionId);
    } catch (error) {
      console.warn("[another-workbench] Failed to generate session title", error);
    }
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
    const session = this.domainService.requireSession(sessionId);
    const engineId = this.resolveSessionEngineId(session);
    const binding = this.requireBinding(engineId);
    if (!binding.adapter) {
      return this.accept(envelope, false);
    }

    await this.ensureAdapterReady(engineId);
    hooks.before?.();
    const result = await binding.adapter.executeCommand(
      this.withSessionWorkingDirectory(envelope, session)
    );
    return this.accept(envelope, result.accepted);
  }

  private withSessionWorkingDirectory(
    envelope: CommandEnvelope,
    session: ReturnType<DomainService["requireSession"]>
  ): CommandEnvelope {
    const cwd =
      session.metadata && typeof session.metadata.cwd === "string"
        ? session.metadata.cwd
        : undefined;
    if (!cwd || !("sessionId" in envelope.command)) {
      return envelope;
    }
    return {
      ...envelope,
      command: {
        ...envelope.command,
        cwd
      } as CommandEnvelope["command"]
    };
  }

  private bindRuntime(sessionId: string): void {
    const session = this.domainService.getSession(sessionId);
    if (!session) {
      return;
    }
    const engineId = this.resolveSessionEngineId(session);
    const binding = this.bindings.get(engineId);
    if (!binding?.adapter) {
      return;
    }

    this.domainService.bindRuntime(session.sessionId, {
      runtimeId: `${engineId}:${session.sessionId}`,
      handle: binding.adapter,
      attachedAt: this.now(),
      metadata: {
        engineId
      }
    });
  }

  private async ensureAdapterReady(engineId: string): Promise<void> {
    if (this.readyEngineIds.has(engineId)) {
      return;
    }
    const binding = this.requireBinding(engineId);
    if (!binding.adapter) {
      return;
    }

    await binding.adapter.initialize({
      ...(binding.runtimeConfig ?? {}),
      metadata: {
        ...(binding.runtimeConfig?.metadata ?? {}),
        selectedConfig: this.engineSelections.get(engineId)
      }
    });

    const unsubscribe = binding.adapter.subscribe((envelope) => {
      this.enqueueAdapterEvent(envelope);
    });
    this.adapterUnsubscribeByEngineId.set(engineId, unsubscribe);
    this.readyEngineIds.add(engineId);
  }

  private enqueueAdapterEvent(envelope: EventEnvelope): void {
    this.adapterEventQueue.push(envelope);
    this.drainAdapterEvents();
  }

  private drainAdapterEvents(): void {
    if (this.isDrainingAdapterEvents) {
      return;
    }
    this.isDrainingAdapterEvents = true;
    try {
      while (this.adapterEventQueueReadIndex < this.adapterEventQueue.length) {
        const envelope = this.adapterEventQueue[this.adapterEventQueueReadIndex++];
        if (!envelope) {
          continue;
        }
        try {
          this.ingestAdapterEvent(envelope);
        } catch (error) {
          console.warn("[another-workbench] Failed to ingest adapter event", error);
        }
        if (
          this.adapterEventQueueReadIndex > 1_024 &&
          this.adapterEventQueueReadIndex * 2 >= this.adapterEventQueue.length
        ) {
          this.adapterEventQueue.splice(0, this.adapterEventQueueReadIndex);
          this.adapterEventQueueReadIndex = 0;
        }
      }
    } finally {
      if (this.adapterEventQueueReadIndex >= this.adapterEventQueue.length) {
        this.adapterEventQueue.length = 0;
        this.adapterEventQueueReadIndex = 0;
      }
      this.isDrainingAdapterEvents = false;
    }
  }

  private ingestAdapterEvent(envelope: EventEnvelope): void {
    this.domainService.ingestRuntimeEvent(envelope.event, envelope.occurredAt);
    this.publishRuntimeEvent(envelope.event);
    this.queueSessionIndexSync(envelope);
  }

  private queueSessionIndexSync(envelope: EventEnvelope): void {
    const sessionId =
      "sessionId" in envelope.event && typeof envelope.event.sessionId === "string"
        ? envelope.event.sessionId
        : undefined;
    if (sessionId && this.shouldSyncSessionIndexForEvent(envelope.event.type)) {
      this.pendingSessionIndexSyncIds.add(sessionId);
    }
    const relation =
      "relation" in envelope.event &&
      envelope.event.relation &&
      typeof envelope.event.relation === "object"
        ? envelope.event.relation
        : undefined;
    if (relation) {
      const workspaceId =
        (sessionId ? this.resolveSessionIndexRecord(sessionId)?.workspaceId : undefined) ??
        this.resolveSessionIndexRecord(relation.parentSessionId)?.workspaceId ??
        this.resolveSessionIndexRecord(relation.childSessionId)?.workspaceId;
      if (workspaceId) {
        const syncInput = {
          workspaceId,
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType,
          sourceTurnId: relation.sourceTurnId,
          createdAt: relation.createdAt
        };
        this.pendingRelationSyncs.set(
          `${syncInput.parentSessionId}\u0000${syncInput.childSessionId}\u0000${syncInput.relationType}`,
          syncInput
        );
      }
    }
    this.startIndexSyncPump();
  }

  private shouldSyncSessionIndexForEvent(eventType: EventEnvelope["event"]["type"]): boolean {
    switch (eventType) {
      case "session.updated":
      case "session.created":
      case "session.disposed":
      case "turn.completed":
      case "message.completed":
        return true;
      default:
        return false;
    }
  }

  private startIndexSyncPump(): void {
    if (this.indexSyncPump) {
      return;
    }
    this.indexSyncPump = this.drainIndexSyncs().finally(() => {
      this.indexSyncPump = undefined;
      if (
        this.pendingSessionIndexSyncIds.size > 0 ||
        this.pendingRelationSyncs.size > 0
      ) {
        this.startIndexSyncPump();
      }
    });
  }

  private async drainIndexSyncs(): Promise<void> {
    while (
      this.pendingSessionIndexSyncIds.size > 0 ||
      this.pendingRelationSyncs.size > 0
    ) {
      const sessionIds = [...this.pendingSessionIndexSyncIds];
      const relations = [...this.pendingRelationSyncs.values()];
      this.pendingSessionIndexSyncIds.clear();
      this.pendingRelationSyncs.clear();

      for (const sessionId of sessionIds) {
        try {
          await this.sessionIndexSyncService.syncSession(sessionId);
        } catch (error) {
          console.warn("[another-workbench] Failed to sync session index entry", error);
        }
      }
      for (const relation of relations) {
        try {
          await this.sessionIndexSyncService.syncRelation(relation);
        } catch (error) {
          console.warn("[another-workbench] Failed to sync session index relation", error);
        }
      }
    }
  }

  private async drainBackgroundWork(): Promise<void> {
    for (let guard = 0; guard < 1_000; guard += 1) {
      if (
        this.adapterEventQueue.length === 0 &&
        !this.indexSyncPump &&
        this.pendingSessionIndexSyncIds.size === 0 &&
        this.pendingRelationSyncs.size === 0
      ) {
        return;
      }
      if (this.adapterEventQueue.length > 0) {
        this.drainAdapterEvents();
        continue;
      }
      if (
        !this.indexSyncPump &&
        (this.pendingSessionIndexSyncIds.size > 0 ||
          this.pendingRelationSyncs.size > 0)
      ) {
        this.startIndexSyncPump();
      }
      const indexPump = this.indexSyncPump;
      if (indexPump) {
        await indexPump;
        continue;
      }
    }
    console.warn("[another-workbench] Timed out while draining runtime background work.");
  }

  private requireBinding(engineId: string): WorkbenchAgentBinding {
    const binding = this.bindings.get(engineId);
    if (!binding) {
      throw new Error(`Unknown engine: ${engineId}`);
    }
    return binding;
  }

  public assertEngineRegistered(engineId: string): void {
    this.requireBinding(engineId);
  }

  private resolveSessionEngineId(session: {
    engineId: string;
    metadata?: Record<string, unknown>;
  }): string {
    return resolveSessionExecutionProfile({
      sessionEngineId: session.engineId,
      metadata: session.metadata
    }).engineId;
  }
}
