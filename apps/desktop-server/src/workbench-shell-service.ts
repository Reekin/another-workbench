import type {
  ChatInteractionCapabilitiesRpc,
  ChatSession,
  ComposerSlashSuggestionRpc,
  CodexHookActivityResultRpc,
  CodexTurnChangesResultRpc,
  CodexTurnChangesUndoResultRpc,
  CommandEnvelope,
  DomainSnapshot,
  DiagnosticsWriteInputRpc,
  DiagnosticsWriteResultRpc,
  EngineDefinitionRpc,
  EngineSharedCapabilityRpc,
  EngineSurfaceRpc,
  EventEnvelope,
  ErrorLogWriteInputRpc,
  ErrorLogWriteResultRpc,
  SchedulerTaskDocumentRpc,
  SessionBrowserPageRpc,
  SessionBrowserPathRpc,
  SkillDescriptorRpc,
  TakeoverPresetDocumentRpc,
  TakeoverPresetSummaryRpc,
  TakeoverSessionStateRpc
} from "@another-workbench/shared";
import type { RuntimeEventFilter, RuntimeEventReplayInput } from "@another-workbench/core";
import {
  type BackgroundRunSnapshot,
  CapabilityRegistry,
  type CapabilityOperationGuard,
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
import type {
  EventReplayResult,
  WorkbenchRuntimeService
} from "./runtime-service.js";
import type { WorkspaceRecord } from "./workspace-registry.js";
import { WorkspaceSelectionService } from "./workspace-selection-service.js";
import { EngineRegistryService } from "./engine-control/engine-registry.js";
import { EngineCapabilitySurfaceService } from "./engine-control/capability-surface.js";
import {
  buildSessionWindowSnapshotFromPage,
  buildSessionWindowSnapshot,
  type SessionWindowSnapshot
} from "./session-window.js";
import { FileActionService } from "./file-action-service.js";
import { FilePreviewService } from "./file-preview-service.js";
import { WorkspaceFileSearchService } from "./workspace-file-search-service.js";
import { TurnChangeService } from "./turn-change-service.js";
import { CodexHookActivityService } from "./engine-extensions/codex/hook-activity-service.js";
import { CodexTurnChangesService } from "./engine-extensions/codex/turn-changes-service.js";
import { ErrorLogService } from "./error-log-service.js";
import { DiagnosticLogService } from "./diagnostic-log-service.js";
import { TakeoverPresetStore } from "./takeover-preset-store.js";
import type { SmartTakeoverService } from "./smart-takeover-service.js";
import { SchedulerStore } from "./scheduler-store.js";
import {
  SchedulerWorkbenchBridge,
  type RunSchedulerTaskResult
} from "./scheduler-workbench-bridge.js";

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
  goal: {
    id: "goal",
    label: "/goal",
    detail: "Set the current Codex goal",
    replacement: "/goal",
    sourceCapability: "goal"
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
  errorLogService?: ErrorLogService;
  diagnosticLogService?: DiagnosticLogService;
  turnChangeService?: TurnChangeService;
  codexHookActivityService?: CodexHookActivityService;
  codexTurnChangesService?: CodexTurnChangesService;
  takeoverPresetStore?: TakeoverPresetStore;
  smartTakeoverService?: SmartTakeoverService;
  schedulerStore?: SchedulerStore;
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
  private readonly errorLogService: ErrorLogService;
  private readonly diagnosticLogService: DiagnosticLogService;
  private readonly turnChangeService: TurnChangeService;
  private readonly codexHookActivityService: CodexHookActivityService;
  private readonly codexTurnChangesService: CodexTurnChangesService;
  private readonly takeoverPresetStore: TakeoverPresetStore;
  private readonly smartTakeoverService: SmartTakeoverService | undefined;
  private readonly schedulerBridge: SchedulerWorkbenchBridge;
  private openSessionGeneration = 0;
  private activationQueue: Promise<void> = Promise.resolve();
  private readonly partiallyHydratedSessionIds = new Set<string>();

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
    this.errorLogService =
      options.errorLogService ?? new ErrorLogService();
    this.diagnosticLogService =
      options.diagnosticLogService ?? new DiagnosticLogService();
    this.takeoverPresetStore =
      options.takeoverPresetStore ?? new TakeoverPresetStore();
    this.smartTakeoverService = options.smartTakeoverService;
    this.schedulerBridge = new SchedulerWorkbenchBridge({
      runtimeService: options.runtimeService,
      schedulerStore: options.schedulerStore,
      smartTakeoverService: options.smartTakeoverService,
      resolveDefaultEngineId: () => this.resolveDefaultNewSessionEngineId()
    });
    this.turnChangeService =
      options.turnChangeService ?? new TurnChangeService();
    this.codexHookActivityService =
      options.codexHookActivityService ??
      new CodexHookActivityService({
        resolveSessionEngineId: (sessionId) =>
          this.sessionIdentity.resolveContext(sessionId).engineId
      });
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

  private async resolveDefaultNewSessionEngineId(): Promise<string | undefined> {
    const registry = this.runtimeService.getWorkspaceRegistry?.();
    await registry?.ready();
    const workspaceState =
      typeof registry?.getState === "function" ? registry.getState() : undefined;
    return (
      workspaceState?.defaultNewSessionEngineId ??
      this.runtimeService.getSelectedEngineId?.()
    );
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

  public async listTakeoverPresets(): Promise<{
    rootPath: string;
    presets: TakeoverPresetSummaryRpc[];
  }> {
    return this.takeoverPresetStore.list();
  }

  public async readTakeoverPreset(input: {
    presetId: string;
  }): Promise<TakeoverPresetDocumentRpc> {
    return this.takeoverPresetStore.read(input.presetId);
  }

  public async upsertTakeoverPreset(input: {
    presetId: string;
    prompt: string;
    displayName?: string;
  }): Promise<TakeoverPresetDocumentRpc> {
    return this.takeoverPresetStore.upsert(input);
  }

  public async deleteTakeoverPreset(input: {
    presetId: string;
  }): Promise<{ presetId: string; deleted: boolean }> {
    return this.takeoverPresetStore.delete(input.presetId);
  }

  public async listSchedulerTasks(input: {
    workspaceId: string;
  }): Promise<{ rootPath: string; tasks: SchedulerTaskDocumentRpc[] }> {
    return this.schedulerBridge.listTasks(input);
  }

  public async upsertSchedulerTask(input: {
    taskId?: string;
    name: string;
    enabled: boolean;
    schedule: SchedulerTaskDocumentRpc["schedule"];
    startDate?: string;
    endDate?: string;
    workspaceId: string;
    prompt: string;
  }): Promise<SchedulerTaskDocumentRpc> {
    return this.schedulerBridge.upsertTask(input);
  }

  public async deleteSchedulerTask(input: {
    taskId: string;
    workspaceId: string;
  }): Promise<{ taskId: string; deleted: boolean }> {
    return this.schedulerBridge.deleteTask(input);
  }

  public async runSchedulerTask(input: {
    taskId: string;
    scheduledAt?: string;
    schedulerRootPath?: string;
    waitForCompletion?: boolean;
  }): Promise<RunSchedulerTaskResult> {
    return this.schedulerBridge.runTask(input);
  }

  public getTakeoverState(input: {
    sessionId: string;
  }): TakeoverSessionStateRpc {
    return (
      this.smartTakeoverService?.getSessionState(input.sessionId) ?? {
        sessionId: input.sessionId,
        role: "none",
        active: false
      }
    );
  }

  public async setManualTakeover(input: {
    sessionId: string;
    presetId?: string;
    context?: string;
  }): Promise<TakeoverSessionStateRpc> {
    if (!this.smartTakeoverService) {
      return {
        sessionId: input.sessionId,
        role: "none",
        active: false
      };
    }
    return this.smartTakeoverService.setManualTakeover(input);
  }

  public async executeCommand(input: CommandEnvelope) {
    if ("sessionId" in input.command && typeof input.command.sessionId === "string") {
      await this.ensureSessionReadyForCommand(input.command);
    }
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

  public isSessionPartiallyHydrated(sessionId: string): boolean {
    return this.partiallyHydratedSessionIds.has(sessionId);
  }

  public async ensureSessionLoadedForRead(
    sessionId: string,
    input: {
      force?: boolean;
    } = {}
  ): Promise<boolean> {
    const loaded =
      (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, input)) ?? false;
    if (loaded) {
      this.partiallyHydratedSessionIds.delete(sessionId);
    }
    return loaded;
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

  public replayResult(input: RuntimeEventReplayInput = {}): EventReplayResult {
    return this.runtimeService.replayResult(input);
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
    return registry.registerWorkspace({
      absolutePath: input.rootPath,
      label: input.label
    });
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

  public async setWorkspaceExpanded(
    workspaceId: string,
    expanded: boolean
  ): Promise<{ workspaceId: string; expanded: boolean }> {
    const registry = this.requireWorkspaceRegistry();
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

  public async listSessionRoots(input: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): Promise<SessionBrowserPageRpc> {
    return this.sessionCatalog.listRoots(input);
  }

  public async listSessionChildren(input: {
    workspaceId: string;
    parentSessionId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): Promise<SessionBrowserPageRpc> {
    return this.sessionCatalog.listChildren(input);
  }

  public async getSessionBrowserPath(sessionId: string): Promise<SessionBrowserPathRpc> {
    return this.sessionCatalog.getPath(sessionId);
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
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    const workspace = registry.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }
    const metadata = {
      ...(input.metadata ?? {}),
      cwd: workspace.absolutePath
    };
    const session = await this.runtimeService.createSession({
      type: "createSession",
      engineId: input.engineId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionProfile: input.sessionProfile,
      metadata
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
    const engineId =
      session?.engineId ?? this.sessionIdentity.resolveContext(sessionId).indexEntry?.engineId;
    if (!engineId) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sharedCapabilities = this.getEngineSurface(engineId).sharedCapabilities;

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

  public async openSession(
    sessionId: string,
    input: {
      forceProviderHydration?: boolean;
    } = {}
  ): Promise<{ page: SessionWindowSnapshot }> {
    const generation = ++this.openSessionGeneration;
    const isCancelled = () => generation !== this.openSessionGeneration;
    const loadedSession = this.runtimeService
      .listSessions({ includeArchived: true })
      .find((session) => session.sessionId === sessionId);
    const alreadyLoaded = Boolean(loadedSession);
    const isProviderSession = Boolean(
      loadedSession?.metadata?.providerKind &&
        loadedSession.metadata.providerSessionId
    );
    const hasProjectedTurns = alreadyLoaded
      ? this.runtimeService
          .getSnapshot()
          .turns.some((turn) => turn.sessionId === sessionId)
      : false;
    const isUncoveredProviderSession = isProviderSession && !hasProjectedTurns;
    const alreadyFullyLoaded =
      alreadyLoaded &&
      !isUncoveredProviderSession &&
      !this.partiallyHydratedSessionIds.has(sessionId);
    const anchorTurnId = await this.resolveProviderAnchorTurnId(sessionId);
    if (isCancelled()) {
      throw new Error("Open session cancelled.");
    }
    if (input.forceProviderHydration || !alreadyFullyLoaded) {
      const hydratedPage = await this.hydrateSessionWindow(sessionId, {
        limit: defaultSessionWindowLimit,
        anchorTurnId,
        isCancelled
      });
      if (isCancelled()) {
        throw new Error("Open session cancelled.");
      }
      if (hydratedPage) {
        await this.activateOpenedSession(sessionId, { isCancelled });
        return {
          page: hydratedPage
        };
      }
    }
    if (!alreadyFullyLoaded) {
      const loadedByFullHydration =
        (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
          isCancelled,
          force: alreadyLoaded
        })) ?? false;
      if (isCancelled()) {
        throw new Error("Open session cancelled.");
      }
      if (alreadyLoaded && !loadedByFullHydration) {
        throw new Error("This session could not be fully loaded.");
      }
      if (loadedByFullHydration) {
        this.partiallyHydratedSessionIds.delete(sessionId);
      }
    }
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.session && !context.providerHandle) {
      throw new Error(
        "This session does not expose a loadable provider session id. It was likely created by an older build and can no longer be reopened."
      );
    }
    if (isCancelled()) {
      throw new Error("Open session cancelled.");
    }
    await this.activateOpenedSession(sessionId, { isCancelled });
    return {
      page: this.buildSessionWindow(sessionId, {
        limit: defaultSessionWindowLimit,
        anchorTurnId
      })
    };
  }

  public async activateSession(sessionId: string): Promise<{ sessionId: string }> {
    const generation = ++this.openSessionGeneration;
    const isCancelled = () => generation !== this.openSessionGeneration;
    const context = this.sessionIdentity.resolveContext(sessionId);
    if (!context.session && !context.indexEntry && !context.providerHandle) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.activateOpenedSession(sessionId, { isCancelled });
    return {
      sessionId
    };
  }

  public async loadOlderSessionTurns(input: {
    sessionId: string;
    beforeTurnId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ page: SessionWindowSnapshot }> {
    if (input.cursor) {
      const hydratedPage = await this.hydrateSessionWindow(input.sessionId, {
        limit: input.limit ?? defaultSessionWindowLimit,
        cursor: input.cursor
      });
      if (hydratedPage) {
        return {
          page: hydratedPage
        };
      }
    }
    const forceFullHydration = this.partiallyHydratedSessionIds.has(input.sessionId);
    const loadedByFullHydration =
      (await this.sessionReconciliation?.ensureSessionLoaded(input.sessionId, {
        force: forceFullHydration
      })) ?? false;
    if (forceFullHydration && !loadedByFullHydration) {
      throw new Error("This session could not be fully loaded.");
    }
    if (loadedByFullHydration) {
      this.partiallyHydratedSessionIds.delete(input.sessionId);
    }
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
    if (input.action === "resume") {
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
    expectedRevision?: number;
  }): Promise<{ jumped: boolean }> {
    await this.applyCapabilityOperationGuards(
      input.sessionId,
      this.capabilities?.getOperationGuards(input.sessionId, "conversationGraph.jump") ??
        []
    );
    return this.capabilities
      ? this.capabilities.jumpConversationGraph(
          input.sessionId,
          input.nodeId,
          input.expectedRevision
        )
      : this.requireChatTreeProvider().jump(
          input.sessionId,
          input.nodeId,
          input.expectedRevision
        );
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

  public async writeErrorLog(
    input: ErrorLogWriteInputRpc
  ): Promise<ErrorLogWriteResultRpc> {
    return this.errorLogService.write(input);
  }

  public async writeDiagnosticLog(
    input: DiagnosticsWriteInputRpc
  ): Promise<DiagnosticsWriteResultRpc> {
    return this.diagnosticLogService.write(input);
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

  public async getCodexHookActivity(input: {
    sessionId: string;
    turnId: string;
  }): Promise<CodexHookActivityResultRpc> {
    return this.codexHookActivityService.getHookActivity(input);
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

  private async activateOpenedSession(
    sessionId: string,
    input: {
      isCancelled?: () => boolean;
    } = {}
  ): Promise<void> {
    const run = this.activationQueue
      .catch(() => undefined)
      .then(async () => {
        const context = this.sessionIdentity.resolveContext(sessionId);
        if (input.isCancelled?.()) {
          throw new Error("Open session cancelled.");
        }
        await this.createWorkspaceSelectionService().activateSelection({
          workspaceId: context.indexEntry?.workspaceId,
          sessionId
        });
        if (input.isCancelled?.()) {
          throw new Error("Open session cancelled.");
        }
        await this.sessionCatalog.markSessionRead(sessionId);
        if (input.isCancelled?.()) {
          throw new Error("Open session cancelled.");
        }
      });
    this.activationQueue = run.catch(() => undefined);
    await run;
  }

  private async ensureSessionReadyForCommand(
    command: Extract<CommandEnvelope["command"], { sessionId: string }>
  ): Promise<void> {
    const requiresFullHydration =
      command.type === "forkSession" ||
      command.type === "steerTurn" ||
      command.type === "interruptTurn" ||
      command.type === "respondApproval" ||
      command.type === "respondInteraction";
    await this.ensureInteractiveSessionLoaded(command.sessionId, {
      requiresFullHydration
    });
  }

  private async applyCapabilityOperationGuards(
    sessionId: string,
    guards: readonly CapabilityOperationGuard[]
  ): Promise<void> {
    if (guards.includes("interactive-session")) {
      await this.ensureInteractiveSessionLoaded(sessionId);
    }
  }

  private async ensureInteractiveSessionLoaded(
    sessionId: string,
    input: {
      requiresFullHydration?: boolean;
    } = {}
  ): Promise<void> {
    const current = this.runtimeService.getSession(sessionId);
    const needsFullHydration =
      !current || this.partiallyHydratedSessionIds.has(sessionId);
    if (!needsFullHydration) {
      return;
    }
    const loaded =
      (await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
        force: Boolean(current)
      })) ?? false;
    if (loaded) {
      this.partiallyHydratedSessionIds.delete(sessionId);
    }
    if (!this.runtimeService.getSession(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (
      input.requiresFullHydration &&
      this.partiallyHydratedSessionIds.has(sessionId)
    ) {
      throw new Error(`Session could not be fully loaded: ${sessionId}`);
    }
  }

  private async hydrateSessionWindow(
    sessionId: string,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
      isCancelled?: () => boolean;
    }
  ): Promise<SessionWindowSnapshot | undefined> {
    const hydration = this.sessionReconciliation?.hydrateSessionWindow?.(
      sessionId,
      input
    );
    const hydrated = await hydration?.catch(() => undefined);
    if (!hydrated || input.isCancelled?.()) {
      return undefined;
    }
    this.partiallyHydratedSessionIds.add(sessionId);
    const snapshotResult = this.getRuntimeSnapshotResult();
    const snapshot = snapshotResult.snapshot;
    const participants = snapshot.participants.filter(
      (participant) => participant.conversationId === hydrated.conversation.conversationId
    );
    const sessionRelations = snapshot.sessionRelations.filter(
      (relation) =>
        relation.parentSessionId === sessionId || relation.childSessionId === sessionId
    );
    return buildSessionWindowSnapshotFromPage({
      sessionId,
      cursor: snapshotResult.cursor,
      conversation: hydrated.conversation,
      session: hydrated.session,
      turns: hydrated.turns,
      messageBlocks: hydrated.messageBlocks,
      toolCalls: hydrated.toolCalls,
      terminalStreams: hydrated.terminalStreams,
      approvalRequests: snapshot.approvalRequests.filter(
        (approval) => approval.sessionId === sessionId
      ),
      runtimeInteractions: (snapshot.runtimeInteractions ?? []).filter(
        (interaction) => interaction.sessionId === sessionId
      ),
      threadGoals: (snapshot.threadGoals ?? []).filter(
        (goal) => goal.sessionId === sessionId
      ),
      participants,
      sessionRelations,
      hasOlder: hydrated.hasOlder,
      hasNewer: hydrated.hasNewer,
      olderCursor: hydrated.olderCursor,
      newerCursor: hydrated.newerCursor
    });
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
      const visibleAnchorTurnId = chatTree.visibleTurnIds?.at(-1);
      if (visibleAnchorTurnId) {
        return visibleAnchorTurnId;
      }
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
    const snapshotResult = this.getRuntimeSnapshotResult();
    const snapshot = snapshotResult.snapshot;
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
      cursor: snapshotResult.cursor,
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
      runtimeInteractions: (snapshot.runtimeInteractions ?? []).filter(
        (interaction) => interaction.sessionId === sessionId
      ),
      threadGoals: (snapshot.threadGoals ?? []).filter(
        (goal) => goal.sessionId === sessionId
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

  private getRuntimeSnapshotResult(): {
    snapshot: ReturnType<WorkbenchRuntimeService["getSnapshot"]>;
    cursor?: string;
  } {
    const runtimeService = this.runtimeService as WorkbenchRuntimeService & {
      getSnapshotResult?: () => {
        snapshot: ReturnType<WorkbenchRuntimeService["getSnapshot"]>;
        cursor?: string;
      };
    };
    return (
      runtimeService.getSnapshotResult?.() ?? {
        snapshot: this.runtimeService.getSnapshot()
      }
    );
  }
}
