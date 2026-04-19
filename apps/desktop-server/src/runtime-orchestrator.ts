import type { AgentDescriptor, ProviderSessionHandle } from "@another-workbench/shared";
import { parseCommandEnvelope } from "@another-workbench/shared";
import type { CommandEnvelope, EventEnvelope } from "@another-workbench/shared";
import type { HydratedSessionSnapshot } from "./session-discovery.js";
import { DomainService } from "./domain-service.js";
import { SessionIndexSyncService } from "./session-index-sync-service.js";
import type { SessionRelationIndex } from "./session-index.js";
import {
  type AgentSelectionInput,
  type CommandReceipt,
  type WorkbenchAgentBinding
} from "./runtime-types.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";

type Clock = () => string;
type IdFactory = () => string;

export type RuntimeOrchestratorOptions = {
  domainService: DomainService;
  sessionIndexSyncService: SessionIndexSyncService;
  workspaceSelectionService: WorkspaceSelectionService;
  publishRuntimeEvent: (event: EventEnvelope["event"]) => void;
  agents?: AgentDescriptor[];
  agentBindings?: WorkbenchAgentBinding[];
  now?: Clock;
  createConversationId?: IdFactory;
};

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

export class RuntimeOrchestrator {
  private readonly bindings = new Map<string, WorkbenchAgentBinding>();
  private readonly agentSelections = new Map<string, Record<string, unknown> | undefined>();
  private readonly adapterUnsubscribeByAgentId = new Map<string, () => void>();
  private readonly readyAgentIds = new Set<string>();
  private readonly domainService: DomainService;
  private readonly sessionIndexSyncService: SessionIndexSyncService;
  private readonly workspaceSelectionService: WorkspaceSelectionService;
  private readonly publishRuntimeEvent: (event: EventEnvelope["event"]) => void;
  private readonly now: Clock;
  private readonly createConversationId: IdFactory;
  private selectedAgentId: string | undefined;

  public constructor(options: RuntimeOrchestratorOptions) {
    this.domainService = options.domainService;
    this.sessionIndexSyncService = options.sessionIndexSyncService;
    this.workspaceSelectionService = options.workspaceSelectionService;
    this.publishRuntimeEvent = options.publishRuntimeEvent;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createConversationId =
      options.createConversationId ?? (() => createOpaqueId("conversation"));

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

  public getAgentDescriptor(agentId: string): AgentDescriptor | undefined {
    return this.bindings.get(agentId)?.descriptor;
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
        return receipt;
      }
      case "interruptTurn":
        return this.forwardSessionCommand(envelope.command.sessionId, envelope);
      case "respondApproval":
        return this.forwardSessionCommand(envelope.command.sessionId, envelope);
      default: {
        const exhaustive: never = envelope.command;
        return exhaustive;
      }
    }
  }

  public async createSession(command: {
    conversationId?: string;
    agentId: string;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }) {
    const conversationId = command.conversationId ?? this.createConversationId();
    this.assertAgentExists(command.agentId);
    const session = this.domainService.createSession({
      conversationId,
      agentId: command.agentId,
      metadata: command.metadata,
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

  public async resumeSession(sessionId: string) {
    const session = this.domainService.resumeSession(sessionId);
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
    for (const unsubscribe of this.adapterUnsubscribeByAgentId.values()) {
      unsubscribe();
    }
    this.adapterUnsubscribeByAgentId.clear();

    for (const binding of this.bindings.values()) {
      await binding.adapter?.dispose();
    }
    this.readyAgentIds.clear();
  }

  public resolveSessionIndexRecord(sessionId: string) {
    const session = this.domainService.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const conversation = this.domainService.getConversation(session.conversationId);
    const binding = this.bindings.get(session.agentId);
    return {
      workspaceId: conversation?.workspaceId,
      session,
      providerKind: binding?.providerKind,
      providerSessionId: binding?.resolveProviderSessionId?.(session.sessionId)
    };
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
    const binding = this.requireBinding(session.agentId);
    if (!binding.adapter) {
      return this.accept(envelope, false);
    }

    await this.ensureAdapterReady(session.agentId);
    hooks.before?.();
    const result = await binding.adapter.executeCommand(envelope);
    return this.accept(envelope, result.accepted);
  }

  private bindRuntime(sessionId: string): void {
    const session = this.domainService.getSession(sessionId);
    if (!session) {
      return;
    }
    const binding = this.bindings.get(session.agentId);
    if (!binding?.adapter) {
      return;
    }

    this.domainService.bindRuntime(session.sessionId, {
      runtimeId: `${session.agentId}:${session.sessionId}`,
      handle: binding.adapter,
      attachedAt: this.now(),
      metadata: {
        agentId: session.agentId
      }
    });
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
    this.domainService.ingestRuntimeEvent(envelope.event, envelope.occurredAt);
    const sessionId =
      "sessionId" in envelope.event && typeof envelope.event.sessionId === "string"
        ? envelope.event.sessionId
        : undefined;
    if (sessionId) {
      await this.sessionIndexSyncService.syncSession(sessionId);
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
        await this.sessionIndexSyncService.syncRelation({
          workspaceId,
          parentSessionId: relation.parentSessionId,
          childSessionId: relation.childSessionId,
          relationType: relation.relationType,
          sourceTurnId: relation.sourceTurnId,
          createdAt: relation.createdAt
        });
      }
    }
    this.publishRuntimeEvent(envelope.event);
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
}
