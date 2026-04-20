import {
  createAcpAdapter,
  createCodexAdapter
} from "@another-workbench/adapters";
import { createCodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import { createPiAcpRuntimePort } from "./pi-acp-runtime-port.js";
import { WorkbenchRuntimeService } from "./runtime-service.js";
import { SessionIndexStore } from "./session-index.js";
import { SessionCatalogService } from "./session-catalog.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  CodexSessionDiscoveryProvider,
  SessionReconciliationService
} from "./session-discovery.js";
import { WorkbenchShellService } from "./workbench-shell-service.js";
import { WorkspaceRegistryService } from "./workspace-registry.js";
import { CodexSessionActionsProvider } from "./codex-session-actions-provider.js";
import { CodexChatTreeAgentProvider } from "./codex-chat-tree-provider.js";
import { SessionIdentityRegistry } from "./session-identity-registry.js";
import { CodexDelegationProvider } from "./codex-delegation-provider.js";
import { CodexWorktreeProvider } from "./codex-worktree-provider.js";
import { CodexCheckpointProvider } from "./codex-checkpoint-provider.js";
import { CodexDiagnosticsProvider } from "./codex-diagnostics-provider.js";
import { EngineRegistryService } from "./engine-control/engine-registry.js";
import { EngineCapabilitySurfaceService } from "./engine-control/capability-surface.js";

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
  const engineRegistry = new EngineRegistryService({
    engines: [
      {
        engineId: codexAgentId,
        displayName: "Codex",
        integrationTier: "native",
        transportKind: "codex"
      },
      {
        engineId: piAgentId,
        displayName: "Pi",
        integrationTier: "fallback",
        transportKind: "acp"
      }
    ]
  });
  const engineCapabilitySurface = new EngineCapabilitySurfaceService({
    surfaces: [
      {
        engineId: codexAgentId,
        sharedCapabilities: [
          "chat",
          "tool",
          "terminal",
          "approval",
          "conversationGraph",
          "delegation",
          "checkpoint"
        ],
        extensions: [
          {
            engineId: codexAgentId,
            key: "worktree",
            displayName: "Worktree Inspector",
            description: "Codex-specific worktree and rollout context.",
            available: true
          },
          {
            engineId: codexAgentId,
            key: "diagnostics",
            displayName: "Diagnostics Summary",
            description: "Codex-specific diagnostics snapshot surface.",
            available: true
          }
        ]
      },
      {
        engineId: piAgentId,
        sharedCapabilities: ["chat", "tool", "approval"],
        extensions: []
      }
    ]
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
        integrationTier: "native",
        transportKind: "codex",
        adapter: codexAdapter,
        providerKind: "codex-thread",
        sharedCapabilities: engineCapabilitySurface.get(codexAgentId).sharedCapabilities,
        extensions: engineCapabilitySurface.get(codexAgentId).extensions,
        resolveProviderSessionId: (sessionId: string) =>
          codexRuntimePort.getThreadIdForSession(sessionId)
      },
      {
        descriptor: {
          agentId: piAgentId,
          displayName: "Pi",
          capabilities: ["chat", "tool", "approval"]
        },
        integrationTier: "fallback",
        transportKind: "acp",
        sharedCapabilities: engineCapabilitySurface.get(piAgentId).sharedCapabilities,
        extensions: engineCapabilitySurface.get(piAgentId).extensions,
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
  const sessionIdentity = new SessionIdentityRegistry({
    runtimeService,
    sessionIndexStore
  });
  const capabilities = new CapabilityRegistry({
    runtimeService,
    sessionIndexStore,
    sessionIdentity,
    capabilities: [
      {
        agentId: codexAgentId,
        sessionDiscovery: new CodexSessionDiscoveryProvider({
          codexRuntimePort
        }),
        sessionActions: new CodexSessionActionsProvider({
          codexRuntimePort
        }),
        conversationGraph: new CodexChatTreeAgentProvider({
          codexRuntimePort,
          now: options.now
        }),
        delegation: new CodexDelegationProvider(),
        worktree: new CodexWorktreeProvider({
          codexRuntimePort,
          now: options.now
        }),
        checkpoint: new CodexCheckpointProvider({
          codexRuntimePort,
          now: options.now
        }),
        diagnostics: new CodexDiagnosticsProvider({
          codexRuntimePort,
          now: options.now
        })
      },
      {
        agentId: piAgentId
      }
    ],
    now: options.now
  });
  const sessionReconciliation = new SessionReconciliationService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore,
    sessionIdentity,
    capabilityRegistry: capabilities
  });

  return new WorkbenchShellService({
    runtimeService,
    sessionCatalog,
    capabilities,
    sessionIdentity,
    sessionReconciliation,
    engineRegistry,
    engineCapabilitySurface,
    pickWorkspaceDirectory: options.pickWorkspaceDirectory
  });
};

export const createCodexWorkbenchRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => createWorkbenchRuntimeService(options);
