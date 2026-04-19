import {
  createAcpAdapter,
  createCodexAdapter
} from "@another-workbench/adapters";
import { createCodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import { createPiAcpRuntimePort } from "./pi-acp-runtime-port.js";
import { WorkbenchRuntimeService } from "./runtime-service.js";
import { SessionIndexStore } from "./session-index.js";
import { SessionCatalogService } from "./session-catalog.js";
import { SessionActionsProvider } from "./session-actions.js";
import { ChatTreeProvider } from "./chat-tree-provider.js";
import {
  CodexSessionDiscoveryProvider,
  SessionReconciliationService
} from "./session-discovery.js";
import { WorkbenchShellService } from "./workbench-shell-service.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { CodexSessionActionsProvider } from "./codex-session-actions-provider.js";
import { CodexChatTreeAgentProvider } from "./codex-chat-tree-provider.js";

export type CreateWorkbenchRuntimeServiceOptions = {
  codexCommandPath?: string;
  codexCommandArgs?: string[];
  piAcpCommandPath?: string;
  piAcpCommandArgs?: string[];
  piCommandPath?: string;
  persistenceBaseDir?: string;
  pickWorkspaceDirectory?: () => Promise<{
    canceled: boolean;
    rootPath?: string;
  }>;
  now?: () => string;
};

export const createWorkbenchRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => {
  const codexAgentId = "codex";
  const piAgentId = "pi-acp";
  let service: WorkbenchRuntimeService | undefined;
  const workspaceRegistry = new WorkspaceRegistryService({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const sessionIndexStore = new SessionIndexStore({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const codexRuntimePort = createCodexAppServerRuntimePort({
    agentId: codexAgentId,
    commandPath: options.codexCommandPath,
    commandArgs: options.codexCommandArgs,
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId),
    now: options.now
  });
  const piRuntimePort = createPiAcpRuntimePort({
    agentId: piAgentId,
    commandPath: options.piAcpCommandPath,
    commandArgs: options.piAcpCommandArgs,
    piCommandPath: options.piCommandPath,
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId),
    now: options.now
  });

  const codexAdapter = createCodexAdapter(codexRuntimePort, {
    id: codexAgentId,
    fallbackAgentId: codexAgentId,
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId)
  });
  const piAdapter = createAcpAdapter(piRuntimePort, {
    id: piAgentId,
    fallbackAgentId: piAgentId,
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId)
  });

  const runtimeService = new WorkbenchRuntimeService({
    now: options.now,
    workspaceRegistry,
    sessionIndexStore,
    agentBindings: [
      {
        descriptor: {
          agentId: codexAgentId,
          displayName: "Codex",
          capabilities: ["chat", "tool", "terminal", "approval"]
        },
        adapter: codexAdapter,
        providerKind: "codex-thread",
        resolveProviderSessionId: (sessionId: string) =>
          codexRuntimePort.getThreadIdForSession(sessionId)
      },
      {
        descriptor: {
          agentId: piAgentId,
          displayName: "Pi",
          capabilities: ["chat", "tool", "approval"]
        },
        adapter: piAdapter
      }
    ]
  });

  service = runtimeService;
  const sessionCatalog = new SessionCatalogService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore
  });
  const sessionReconciliation = new SessionReconciliationService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore,
    providers: [
      new CodexSessionDiscoveryProvider({
        codexRuntimePort
      })
    ]
  });
  const sessionActions = new SessionActionsProvider({
    runtimeService,
    sessionIndexStore,
    providers: [
      new CodexSessionActionsProvider({
        codexRuntimePort
      })
    ]
  });
  const chatTreeProvider = new ChatTreeProvider({
    runtimeService,
    sessionIndexStore,
    providers: [
      new CodexChatTreeAgentProvider({
        codexRuntimePort,
        now: options.now
      })
    ],
    now: options.now
  });

  return new WorkbenchShellService({
    runtimeService,
    sessionCatalog,
    sessionActions,
    chatTreeProvider,
    sessionReconciliation,
    pickWorkspaceDirectory: options.pickWorkspaceDirectory
  });
};

export const createCodexWorkbenchRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => createWorkbenchRuntimeService(options);
