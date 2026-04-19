import type {
  AgentDescriptor,
  ChatSession,
  CommandEnvelope,
  DomainSnapshot,
  EventEnvelope
} from "@another-workbench/shared";
import type { RuntimeEventFilter, RuntimeEventReplayInput } from "@another-workbench/core";
import { ChatTreeProvider, type ChatTreeSnapshot } from "./chat-tree-provider.js";
import {
  SessionActionsProvider,
  type SessionActionDescriptor,
  type SessionActionKind,
  type SessionActionResult
} from "./session-actions.js";
import {
  SessionCatalogService,
  type WorkspaceBrowserNode
} from "./session-catalog.js";
import { SessionReconciliationService } from "./session-discovery.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { WorkspaceRecord } from "./workspace-registry.js";
import {
  buildSessionWindowSnapshot,
  type SessionWindowSnapshot
} from "./session-window.js";

const defaultSessionWindowLimit = 8;

export type WorkbenchShellServiceOptions = {
  runtimeService: WorkbenchRuntimeService;
  sessionCatalog: SessionCatalogService;
  sessionActions: SessionActionsProvider;
  chatTreeProvider: ChatTreeProvider;
  sessionReconciliation?: SessionReconciliationService;
  pickWorkspaceDirectory?: () => Promise<{
    canceled: boolean;
    rootPath?: string;
  }>;
};

export class WorkbenchShellService {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly sessionCatalog: SessionCatalogService;
  private readonly sessionActions: SessionActionsProvider;
  private readonly chatTreeProvider: ChatTreeProvider;
  private readonly sessionReconciliation: SessionReconciliationService | undefined;
  private readonly pickWorkspaceDirectoryImpl:
    | (() => Promise<{ canceled: boolean; rootPath?: string }>)
    | undefined;
  private openSessionGeneration = 0;

  public constructor(options: WorkbenchShellServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.sessionCatalog = options.sessionCatalog;
    this.sessionActions = options.sessionActions;
    this.chatTreeProvider = options.chatTreeProvider;
    this.sessionReconciliation = options.sessionReconciliation;
    this.pickWorkspaceDirectoryImpl = options.pickWorkspaceDirectory;
  }

  public listAgents(): AgentDescriptor[] {
    return this.runtimeService.listAgents();
  }

  public selectAgent(input: {
    agentId: string;
    config?: Record<string, unknown>;
  }): { selectedAgentId: string } {
    return this.runtimeService.selectAgent(input);
  }

  public getSelectedAgentId(): string | undefined {
    return this.runtimeService.getSelectedAgentId();
  }

  public async getSettings(): Promise<{
    defaultNewSessionAgentId?: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.ready();
    return {
      defaultNewSessionAgentId: registry.getState().defaultNewSessionAgentId
    };
  }

  public async updateSettings(input: {
    defaultNewSessionAgentId?: string;
  }): Promise<{
    defaultNewSessionAgentId?: string;
  }> {
    const registry = this.requireWorkspaceRegistry();
    await registry.updateSettings(input);
    if (input.defaultNewSessionAgentId) {
      this.runtimeService.selectAgent({
        agentId: input.defaultNewSessionAgentId
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
    const registry = this.requireWorkspaceRegistry();
    const state = registry.getState();
    await registry.setLastActiveSelection({
      workspaceId,
      sessionId:
        state.lastActiveWorkspaceId === workspaceId ? state.lastActiveSessionId : undefined
    });
    return {
      workspaceId,
      activeSessionId:
        state.lastActiveWorkspaceId === workspaceId ? state.lastActiveSessionId : undefined
    };
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
    agentId: string;
    conversationId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    sessionId: string;
    conversationId: string;
  }> {
    const session = await this.runtimeService.createSession({
      type: "createSession",
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      metadata: input.metadata
    });
    await this.sessionCatalog.markSessionRead(session.sessionId);
    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId
    };
  }

  public async openSession(sessionId: string): Promise<{ page: SessionWindowSnapshot }> {
    const generation = ++this.openSessionGeneration;
    const isCancelled = () => generation !== this.openSessionGeneration;
    await this.sessionReconciliation?.ensureSessionLoaded(sessionId, {
      isCancelled
    });
    const loadedSession = this.runtimeService.listSessions({
      includeArchived: true
    }).find((session) => session.sessionId === sessionId);
    const indexedSession = this.runtimeService.getSessionIndexStore()?.getEntry(sessionId);
    if (!loadedSession && !indexedSession?.providerSessionId) {
      throw new Error(
        "This session does not expose a loadable provider session id. It was likely created by an older build and can no longer be reopened."
      );
    }
    const registry = this.requireWorkspaceRegistry();
    const workspaceId = indexedSession?.workspaceId;
    await registry.setLastActiveSelection({
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
      actions: await this.sessionActions.listActions(sessionId)
    };
  }

  public async runSessionAction(input: {
    sessionId: string;
    action: SessionActionKind;
  }): Promise<SessionActionResult> {
    const result = await this.sessionActions.runAction(input.sessionId, input.action);
    if (input.action === "reload") {
      await this.sessionCatalog.markSessionRead(input.sessionId);
    }
    return result;
  }

  public async getChatTree(sessionId: string): Promise<ChatTreeSnapshot> {
    return this.chatTreeProvider.get(sessionId);
  }

  public async jumpChatTree(input: {
    sessionId: string;
    nodeId: string;
  }): Promise<{ jumped: boolean }> {
    return this.chatTreeProvider.jump(input.sessionId, input.nodeId);
  }

  private requireWorkspaceRegistry() {
    const registry = this.runtimeService.getWorkspaceRegistry();
    if (!registry) {
      throw new Error("Workspace registry is unavailable.");
    }
    return registry;
  }

  private async resolveProviderAnchorTurnId(
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const chatTree = await this.chatTreeProvider.get(sessionId);
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
