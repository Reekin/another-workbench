import type {
  ChatInteractionCapabilitiesRpc,
  ChatSession,
  ComposerSlashSuggestionRpc,
  CodexTurnChangesResultRpc,
  CodexTurnChangesUndoResultRpc,
  CommandEnvelope,
  DomainSnapshot,
  EngineDefinitionRpc,
  EngineSharedCapabilityRpc,
  EngineSurfaceRpc,
  EventEnvelope,
  SkillDescriptorRpc
} from "@another-workbench/shared";
import type { RuntimeEventFilter, RuntimeEventReplayInput } from "@another-workbench/core";
import {
  type BackgroundRunSnapshot,
  CapabilityRegistry,
  type CheckpointSnapshot,
  type ConversationGraphSnapshot as ChatTreeSnapshot,
  type DelegationSnapshot,
  type DiagnosticsSnapshot,
  type SessionActionDescriptor,
  type SessionActionKind,
  type SessionActionResult,
  type WorktreeSnapshot
} from "./capability-registry.js";
import { ChatTreeProvider } from "./chat-tree-provider.js";
import {
  SessionCatalogService,
  type WorkspaceBrowserNode
} from "./session-catalog.js";
import { SessionReconciliationService } from "./session-discovery.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import { SessionActionsProvider } from "./session-actions.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { WorkspaceRecord } from "./workspace-registry.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";
import { EngineRegistryService } from "./engine-control/engine-registry.js";
import { EngineCapabilitySurfaceService } from "./engine-control/capability-surface.js";
import {
  buildSessionWindowSnapshot,
  type SessionWindowSnapshot
} from "./session-window.js";
import { FileActionService } from "./file-action-service.js";
import { FilePreviewService } from "./file-preview-service.js";
import { WorkspaceFileSearchService } from "./workspace-file-search-service.js";
import { TurnChangeService } from "./turn-change-service.js";
import { CodexTurnChangesService } from "./engine-extensions/codex/turn-changes-service.js";

const defaultSessionWindowLimit = 8;

const baseComposerSlashSuggestions: readonly ComposerSlashSuggestionRpc[] = [
  {
    id: "status",
    label: "/status",
    detail: "Summarize the current session state",
    replacement: "Summarize the current session status and the next best action."
  }
];

const composerSlashSuggestionsByCapability: Partial<
  Record<EngineSharedCapabilityRpc, ComposerSlashSuggestionRpc>
> = {
  checkpoint: {
    id: "checkpoint",
    label: "/checkpoint",
    detail: "Ask for a checkpoint summary",
    replacement:
      "Summarize the available checkpoints and explain what changed since the latest one.",
    sourceCapability: "checkpoint"
  },
  delegation: {
    id: "delegation",
    label: "/delegation",
    detail: "Explain the current delegation tree",
    replacement:
      "Summarize the current delegation tree and identify blocked or waiting nodes.",
    sourceCapability: "delegation"
  },
  diagnostics: {
    id: "diagnostics",
    label: "/diagnostics",
    detail: "Review diagnostics and suggest the next fix",
    replacement: "Review the current diagnostics and propose the next fix.",
    sourceCapability: "diagnostics"
  },
  worktree: {
    id: "worktree",
    label: "/worktree",
    detail: "Summarize branch and rollout context",
    replacement: "Summarize the current worktree, branch, and rollout context.",
    sourceCapability: "worktree"
  }
};

const resolveComposerSlashSuggestions = (
  sharedCapabilities: readonly EngineSharedCapabilityRpc[]
): ComposerSlashSuggestionRpc[] => {
  const seen = new Set<string>();
  const items: ComposerSlashSuggestionRpc[] = [];

  for (const suggestion of baseComposerSlashSuggestions) {
    seen.add(suggestion.id);
    items.push(suggestion);
  }

  for (const capability of sharedCapabilities) {
    const suggestion = composerSlashSuggestionsByCapability[capability];
    if (!suggestion || seen.has(suggestion.id)) {
      continue;
    }
    seen.add(suggestion.id);
    items.push(suggestion);
  }

  return items;
};

export type WorkbenchShellServiceOptions = {
  runtimeService: WorkbenchRuntimeService;
  sessionCatalog: SessionCatalogService;
  capabilities?: CapabilityRegistry;
  skillsProvider?: {
    listSkills: (input?: {
      cwds?: string[];
      forceReload?: boolean;
    }) => Promise<SkillDescriptorRpc[]>;
  };
  sessionIdentity?: SessionIdentityRegistry;
  sessionActions?: SessionActionsProvider;
  chatTreeProvider?: ChatTreeProvider;
  sessionReconciliation?: SessionReconciliationService;
  engineRegistry?: EngineRegistryService;
  engineCapabilitySurface?: EngineCapabilitySurfaceService;
  pickWorkspaceDirectory?: () => Promise<{
    canceled: boolean;
    rootPath?: string;
  }>;
  fileSearchService?: WorkspaceFileSearchService;
  filePreviewService?: FilePreviewService;
  fileActionService?: FileActionService;
  turnChangeService?: TurnChangeService;
  codexTurnChangesService?: CodexTurnChangesService;
};

export class WorkbenchShellService {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly sessionCatalog: SessionCatalogService;
  private readonly capabilities: CapabilityRegistry | undefined;
  private readonly skillsProvider:
    | WorkbenchShellServiceOptions["skillsProvider"]
    | undefined;
  private readonly sessionActions: SessionActionsProvider | undefined;
  private readonly chatTreeProvider: ChatTreeProvider | undefined;
  private readonly sessionIdentity: SessionIdentityRegistry;
  private readonly sessionReconciliation: SessionReconciliationService | undefined;
  private readonly engineRegistry: EngineRegistryService | undefined;
  private readonly engineCapabilitySurface: EngineCapabilitySurfaceService | undefined;
  private readonly pickWorkspaceDirectoryImpl:
    | (() => Promise<{ canceled: boolean; rootPath?: string }>)
    | undefined;
  private readonly fileSearchService: WorkspaceFileSearchService;
  private readonly filePreviewService: FilePreviewService;
  private readonly fileActionService: FileActionService;
  private readonly turnChangeService: TurnChangeService;
  private readonly codexTurnChangesService: CodexTurnChangesService;
  private openSessionGeneration = 0;

  public constructor(options: WorkbenchShellServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.sessionCatalog = options.sessionCatalog;
    this.capabilities = options.capabilities;
    this.skillsProvider = options.skillsProvider;
    this.sessionActions = options.sessionActions;
    this.chatTreeProvider = options.chatTreeProvider;
    const sessionIndexStore = options.runtimeService.getSessionIndexStore?.();
    this.sessionIdentity =
      options.sessionIdentity ??
      new SessionIdentityRegistry({
        runtimeService: options.runtimeService,
        sessionIndexStore:
          sessionIndexStore ??
          ({
            getEntry: () => undefined,
            listEntries: () => []
          } as never)
      });
    this.sessionReconciliation = options.sessionReconciliation;
    this.engineRegistry = options.engineRegistry;
    this.engineCapabilitySurface = options.engineCapabilitySurface;
    this.pickWorkspaceDirectoryImpl = options.pickWorkspaceDirectory;
    this.fileSearchService =
      options.fileSearchService ?? new WorkspaceFileSearchService();
    this.filePreviewService =
      options.filePreviewService ?? new FilePreviewService();
    this.fileActionService =
      options.fileActionService ?? new FileActionService();
    this.turnChangeService =
      options.turnChangeService ?? new TurnChangeService();
    this.codexTurnChangesService =
      options.codexTurnChangesService ??
      new CodexTurnChangesService({
        resolveSessionEngineId: (sessionId) =>
          this.sessionIdentity.resolveContext(sessionId).engineId,
        resolveWorkingDirectory: (sessionId) =>
          this.resolveTurnChangeWorkingDirectoryBySessionId(sessionId),
        undoTurnChanges: (input) => this.turnChangeService.undoTurnChanges(input)
      });
  }

  public listEngines(): EngineDefinitionRpc[] {
    return this.engineRegistry?.list() ?? [];
  }

  public getEngineSurface(engineId: string): EngineSurfaceRpc {
    return this.engineCapabilitySurface?.get(engineId) ?? {
      engineId,
      sharedCapabilities: [],
      extensions: []
    };
  }

  public selectEngine(input: {
    engineId: string;
    config?: Record<string, unknown>;
  }): { selectedEngineId: string } {
    return this.runtimeService.selectEngine(input);
  }

  public getSelectedEngineId(): string | undefined {
    return this.runtimeService.getSelectedEngineId();
  }

  public async getSettings(): Promise<{
    defaultNewSessionEngineId?: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    return {
      defaultNewSessionEngineId: registry.getState().defaultNewSessionEngineId
    };
  }

  public async updateSettings(input: {
    defaultNewSessionEngineId?: string;
  }): Promise<{
    defaultNewSessionEngineId?: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.updateSettings(input);
    if (input.defaultNewSessionEngineId) {
      this.runtimeService.selectEngine({
        engineId: input.defaultNewSessionEngineId
      });
    }
    return this.getSettings();
  }

  public async executeCommand(input: CommandEnvelope) {
    return this.runtimeService.executeCommand(input);
  }

  public listSessions(options: {
    conversationId?: string;
    includeArchived?: boolean;
  } = {}): ChatSession[] {
    return this.runtimeService.listSessions(options);
  }

  public getSnapshot(): DomainSnapshot {
    return this.runtimeService.getSnapshot();
  }

  public getSnapshotResult() {
    return this.runtimeService.getSnapshotResult();
  }

  public subscribe(
    listener: (envelope: EventEnvelope) => void,
    filter: RuntimeEventFilter = {}
  ): () => void {
    return this.runtimeService.subscribe(listener, filter);
  }

  public subscribeFromCursor(
    listener: (envelope: EventEnvelope) => void,
    input: RuntimeEventReplayInput = {}
  ): () => void {
    return this.runtimeService.subscribeFromCursor(listener, input);
  }

  public replay(input: RuntimeEventReplayInput = {}): EventEnvelope[] {
    return this.runtimeService.replay(input);
  }

  public async dispose(): Promise<void> {
    await this.runtimeService.dispose();
  }

  public async listWorkspaces(): Promise<{
    workspaces: WorkspaceRecord[];
    lastActiveWorkspaceId?: string;
    lastActiveSessionId?: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const state = registry.getState();
    return {
      workspaces: state.workspaces,
      lastActiveWorkspaceId: state.lastActiveWorkspaceId,
      lastActiveSessionId: state.lastActiveSessionId
    };
  }

  public async pickWorkspaceDirectory(): Promise<{
    canceled: boolean;
    rootPath?: string;
  }> {
    if (!this.pickWorkspaceDirectoryImpl) {
      return {
        canceled: true
      };
    }
    return this.pickWorkspaceDirectoryImpl();
  }

  public async addWorkspace(input: {
    rootPath: string;
    label?: string;
  }): Promise<WorkspaceRecord> {
    const registry = this.requireWorkspaceRegistry();
    const workspace = await registry.registerWorkspace({
      absolutePath: input.rootPath,
      label: input.label
    });
    await this.sessionReconciliation?.reconcileWorkspace(workspace.workspaceId);
    return workspace;
  }

  public async removeWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    removed: boolean;
  }> {
    const registry = this.requireWorkspaceRegistry();
    const removed = await registry.removeWorkspace(workspaceId);
    if (removed) {
      await this.runtimeService.getSessionIndexStore()?.removeWorkspace(workspaceId);
    }
    return {
      workspaceId,
      removed
    };
  }

  public async toggleWorkspaceExpanded(workspaceId: string): Promise<{ workspaceId: string; expanded: boolean }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const expanded = !registry.getState().expandedWorkspaceIds.includes(workspaceId);
    await registry.setWorkspaceExpanded(workspaceId, expanded);
    return {
      workspaceId,
      expanded
    };
  }

  public async selectWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    activeSessionId?: string;
  }> {
    return this.createWorkspaceSelectionService().selectWorkspace(workspaceId);
  }

  public async listSessionTree(workspaceId?: string): Promise<{ workspaces: WorkspaceBrowserNode[] }> {
    return {
      workspaces: await this.sessionCatalog.listWorkspaceTree(workspaceId)
    };
  }

  public async reconcileSessionBrowser(workspaceId?: string): Promise<{
    workspaces: number;
    sessions: number;
    relations: number;
  }> {
    return (
      (await this.sessionReconciliation?.reconcileWorkspace(workspaceId)) ?? {
        workspaces: 0,
        sessions: 0,
        relations: 0
      }
    );
  }

  public async toggleSessionExpanded(sessionId: string): Promise<{
    sessionId: string;
    expanded: boolean;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const expanded = !registry.getState().expandedSessionIds.includes(sessionId);
    await registry.setSessionExpanded(sessionId, expanded);
    return {
      sessionId,
      expanded
    };
  }

  public async createBrowserSession(input: {
    workspaceId: string;
    engineId: string;
    conversationId?: string;
    sessionProfile?: {
      modeId?: string;
      modelId?: string;
    };
    metadata?: Record<string, unknown>;
  }): Promise<{
    sessionId: string;
    conversationId: string;
  }> {
    const session = await this.runtimeService.createSession({
      type: "createSession",
      engineId: input.engineId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionProfile: input.sessionProfile,
      metadata: input.metadata
    });
    await this.sessionCatalog.markSessionRead(session.sessionId);
    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId
    };
  }

  public async getChatCapabilities(
    sessionId: string
  ): Promise<ChatInteractionCapabilitiesRpc> {
    const session = this.runtimeService.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sharedCapabilities = this.getEngineSurface(session.engineId).sharedCapabilities;

    return {
      supportsSteer: sharedCapabilities.includes("steer"),
      supportsAttachments: sharedCapabilities.includes("attachments"),
      slashSuggestions: resolveComposerSlashSuggestions(sharedCapabilities)
    };
  }

  public async listSkills(input?: {
    cwds?: string[];
    forceReload?: boolean;
  }): Promise<SkillDescriptorRpc[]> {
    if (!this.skillsProvider) {
      return [];
    }
    return this.skillsProvider.listSkills(input);
  }

  public async openSession(sessionId: string): Promise<{ page: SessionWindowSnapshot }> {
    const generation = ++this.openSessionGeneration;
    const isCancelled = () => generation !== this.openSessionGeneration;
    await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
      isCancelled
    });
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.session && !context.providerHandle) {
      throw new Error(
        "This session does not expose a loadable provider session id. It was likely created by an older build and can no longer be reopened."
      );
    }
    const workspaceId = context.indexEntry?.workspaceId;
    await this.createWorkspaceSelectionService().activateSelection({
      workspaceId,
      sessionId
    });
    await this.sessionCatalog.markSessionRead(sessionId);
    const anchorTurnId = await this.resolveProviderAnchorTurnId(sessionId);
    return {
      page: this.buildSessionWindow(sessionId, {
        limit: defaultSessionWindowLimit,
        anchorTurnId
      })
    };
  }

  public async loadOlderSessionTurns(input: {
    sessionId: string;
    beforeTurnId?: string;
    limit?: number;
  }): Promise<{ page: SessionWindowSnapshot }> {
    await this.sessionReconciliation?.ensureSessionLoaded(input.sessionId);
    return {
      page: this.buildSessionWindow(input.sessionId, {
        limit: input.limit ?? defaultSessionWindowLimit,
        beforeTurnId: input.beforeTurnId
      })
    };
  }

  public async getSessionActions(
    sessionId: string
  ): Promise<{ actions: SessionActionDescriptor[] }> {
    return {
      actions: this.capabilities
        ? await this.capabilities.listSessionActions(sessionId)
        : await this.requireSessionActions().listActions(sessionId)
    };
  }

  public async runSessionAction(input: {
    sessionId: string;
    action: SessionActionKind;
  }): Promise<SessionActionResult> {
    const result = this.capabilities
      ? await this.capabilities.runSessionAction(input.sessionId, input.action)
      : await this.requireSessionActions().runAction(input.sessionId, input.action);
    if (input.action === "reload") {
      await this.sessionCatalog.markSessionRead(input.sessionId);
    }
    return result;
  }

  public async getChatTree(sessionId: string): Promise<ChatTreeSnapshot> {
    return this.capabilities
      ? this.capabilities.getConversationGraph(sessionId)
      : this.requireChatTreeProvider().get(sessionId);
  }

  public async jumpChatTree(input: {
    sessionId: string;
    nodeId: string;
  }): Promise<{ jumped: boolean }> {
    return this.capabilities
      ? this.capabilities.jumpConversationGraph(input.sessionId, input.nodeId)
      : this.requireChatTreeProvider().jump(input.sessionId, input.nodeId);
  }

  public async getDelegation(sessionId: string): Promise<DelegationSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        supportsControl: false,
        nodes: [],
        edges: [],
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getDelegation(sessionId);
  }

  public async getWorktree(sessionId: string): Promise<WorktreeSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getWorktree(sessionId);
  }

  public async getCheckpoint(sessionId: string): Promise<CheckpointSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        supportsRestore: false,
        checkpoints: [],
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getCheckpoint(sessionId);
  }

  public async getDiagnostics(sessionId: string): Promise<DiagnosticsSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        authenticated: false,
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getDiagnostics(sessionId);
  }

  public async getBackgroundRun(sessionId: string): Promise<BackgroundRunSnapshot> {
    if (!this.capabilities) {
      const context = this.sessionIdentity.resolveContext(sessionId);
      if (!context.engineId) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return {
        sessionId,
        engineId: context.engineId,
        supported: false,
        status: "unsupported",
        fetchedAt: new Date().toISOString()
      };
    }
    return this.capabilities.getBackgroundRun(sessionId);
  }

  public async searchWorkspaceFiles(input: {
    workspaceId: string;
    query: string;
    limit?: number;
  }) {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const workspace = registry.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }
    return {
      results: await this.fileSearchService.searchWorkspace({
        workspace,
        query: input.query,
        limit: input.limit
      })
    };
  }

  public async getFilePreview(path: string) {
    return {
      preview: await this.filePreviewService.getPreview(path)
    };
  }

  public async runFileAction(input: {
    path: string;
    action: "open" | "reveal";
  }) {
    return {
      result: await this.fileActionService.runAction(input)
    };
  }

  public async getCodexTurnChanges(input: {
    sessionId: string;
    turnId: string;
  }): Promise<CodexTurnChangesResultRpc> {
    return this.codexTurnChangesService.getTurnChanges(input);
  }

  public async undoCodexTurnChanges(input: {
    sessionId: string;
    turnId: string;
  }): Promise<CodexTurnChangesUndoResultRpc> {
    return this.codexTurnChangesService.undoTurnChanges(input);
  }

  private requireWorkspaceRegistry() {
    const registry = this.runtimeService.getWorkspaceRegistry();
    if (!registry) {
      throw new Error("Workspace registry is unavailable.");
    }
    return registry;
  }

  private createWorkspaceSelectionService(): WorkspaceSelectionService {
    return new WorkspaceSelectionService({
      workspaceRegistry: this.requireWorkspaceRegistry()
    });
  }

  private requireSessionActions(): SessionActionsProvider {
    if (!this.sessionActions) {
      throw new Error("Session actions are unavailable.");
    }
    return this.sessionActions;
  }

  private requireChatTreeProvider(): ChatTreeProvider {
    if (!this.chatTreeProvider) {
      throw new Error("Conversation graph is unavailable.");
    }
    return this.chatTreeProvider;
  }

  private async resolveTurnChangeWorkingDirectoryBySessionId(
    sessionId: string
  ): Promise<string> {
    const context = this.sessionIdentity.resolveContext(sessionId);
    const session = context.session;
    const metadataCwd =
      (session?.metadata && typeof session.metadata.cwd === "string"
        ? session.metadata.cwd
        : undefined) ??
      (context.indexEntry?.metadata && typeof context.indexEntry.metadata.cwd === "string"
        ? context.indexEntry.metadata.cwd
        : undefined);
    if (metadataCwd) {
      return metadataCwd;
    }

    const workspaceId =
      context.indexEntry?.workspaceId ??
      (session
        ? this.runtimeService
            .getSnapshot()
            .conversations.find(
              (item) => item.conversationId === session.conversationId
            )?.workspaceId
        : undefined);
    if (workspaceId) {
      const registry = this.requireWorkspaceRegistry();
      await registry.ready();
      const workspace = registry
        .getState()
        .workspaces.find((item) => item.workspaceId === workspaceId);
      if (workspace) {
        return workspace.absolutePath;
      }
    }

    throw new Error("Unable to resolve a working directory for this turn.");
  }

  private async resolveProviderAnchorTurnId(
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const chatTree = this.capabilities
        ? await this.capabilities.getConversationGraph(sessionId)
        : await this.requireChatTreeProvider().get(sessionId);
      if (!chatTree.currentNodeId) {
        return undefined;
      }
      return chatTree.nodes.find((node) => node.nodeId === chatTree.currentNodeId)?.turnId;
    } catch {
      return undefined;
    }
  }

  private buildSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      beforeTurnId?: string;
      anchorTurnId?: string;
    }
  ): SessionWindowSnapshot {
    const snapshot = this.runtimeService.getSnapshot();
    const session = snapshot.sessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const conversation = snapshot.conversations.find(
      (item) => item.conversationId === session.conversationId
    );
    if (!conversation) {
      throw new Error(`Conversation is unavailable for session: ${sessionId}`);
    }
    return buildSessionWindowSnapshot({
      sessionId,
      conversation,
      session,
      turns: snapshot.turns.filter((turn) => turn.sessionId === sessionId),
      messageBlocks: snapshot.messageBlocks.filter((block) => block.sessionId === sessionId),
      toolCalls: snapshot.toolCalls.filter((toolCall) => toolCall.sessionId === sessionId),
      terminalStreams: snapshot.terminalStreams.filter(
        (terminal) => terminal.sessionId === sessionId
      ),
      approvalRequests: snapshot.approvalRequests.filter(
        (approval) => approval.sessionId === sessionId
      ),
      participants: snapshot.participants.filter(
        (participant) => participant.conversationId === conversation.conversationId
      ),
      sessionRelations: snapshot.sessionRelations.filter(
        (relation) =>
          relation.parentSessionId === sessionId || relation.childSessionId === sessionId
      ),
      limit: input.limit,
      beforeTurnId: input.beforeTurnId,
      anchorTurnId: input.anchorTurnId
    });
  }
}
