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
import { CodexTurnChangesStore } from "./engine-extensions/codex/turn-changes-store.js";
import { FileActionService } from "./file-action-service.js";
import { ErrorLogService } from "./error-log-service.js";
import { DiagnosticLogService } from "./diagnostic-log-service.js";
import { HostToolRegistry } from "./host-tools.js";
import { SmartTakeoverService } from "./smart-takeover-service.js";
import { TakeoverPresetStore } from "./takeover-preset-store.js";
import {
  createOpenAiSessionTitleGenerator,
  type SessionTitleGenerator
} from "./title-generation-service.js";
import type { SkillDescriptorRpc } from "@another-workbench/shared";

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
  openFilePath?: (path: string) => Promise<string | void> | string | void;
  revealFilePath?: (path: string) => Promise<string | void> | string | void;
  titleGenerator?: SessionTitleGenerator;
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
  const codexTurnChangesStore = new CodexTurnChangesStore({
    now: options.now
  });
  const takeoverPresetStore = new TakeoverPresetStore({
    baseDir: options.persistenceBaseDir,
    now: options.now
  });
  const hostTools = new HostToolRegistry();
  const codexRuntimePort = createCodexAppServerRuntimePort({
    engineId: codexAgentId,
    commandPath: options.codexCommandPath,
    commandArgs: options.codexCommandArgs,
    resolveConversationIdBySessionId: (sessionId: string) =>
      service?.resolveConversationIdForSession(sessionId),
    recordTurnChanges: (input) => codexTurnChangesStore.record(input),
    hostTools,
    now: options.now
  });
  const piRuntimePort = createPiAcpRuntimePort({
    engineId: piAgentId,
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
          "steer",
          "tool",
          "terminal",
          "approval",
          "attachments",
          "conversationGraph",
          "delegation",
          "checkpoint",
          "worktree",
          "diagnostics"
        ],
        extensions: [
          {
            engineId: codexAgentId,
            key: "changed-files",
            displayName: "Changed Files",
            description: "Codex turn-level file changes and local undo actions.",
            available: true
          },
          {
            engineId: codexAgentId,
            key: "hook-activity",
            displayName: "Hook Activity",
            description: "Codex hook runs, statuses, and hook output entries.",
            available: true
          }
        ]
      },
      {
        engineId: piAgentId,
        sharedCapabilities: ["chat", "tool", "approval", "attachments"],
        extensions: []
      }
    ]
  });

  const runtimeService = new WorkbenchRuntimeService({
    now: options.now,
    workspaceRegistry,
    sessionIndexStore,
    titleGenerator:
      options.titleGenerator ??
      createOpenAiSessionTitleGenerator({
        resolveAuth: () => codexRuntimePort.readOpenAiCompatibleAuth()
      }),
    agentBindings: [
      {
        descriptor: {
          engineId: codexAgentId,
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
          engineId: piAgentId,
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
  const smartTakeoverService = new SmartTakeoverService({
    runtimeService,
    presetStore: takeoverPresetStore,
    now: options.now
  });
  for (const tool of smartTakeoverService.createHostTools()) {
    hostTools.register(tool);
  }
  const sessionCatalog = new SessionCatalogService({
    runtimeService,
    workspaceRegistry,
    sessionIndexStore,
    resolveTakeoverMarker: (sessionId) =>
      smartTakeoverService.getSessionMarker(sessionId)
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
        engineId: codexAgentId,
        operationGuards: {
          "conversationGraph.jump": ["interactive-session"]
        },
        sessionDiscovery: new CodexSessionDiscoveryProvider({
          codexRuntimePort,
          turnChangesStore: codexTurnChangesStore
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
        engineId: piAgentId
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
    skillsProvider: {
      listSkills: async (input): Promise<SkillDescriptorRpc[]> => {
        const result = await codexRuntimePort.listSkills({
          cwds: input?.cwds,
          forceReload: input?.forceReload
        });
        return result.data.flatMap((entry) =>
          entry.skills.map((skill) => ({
            cwd: entry.cwd,
            name: skill.name,
            description: skill.description,
            shortDescription: skill.shortDescription ?? undefined,
            path: skill.path,
            scope: String(skill.scope),
            enabled: skill.enabled
          }))
        );
      }
    },
    sessionIdentity,
    sessionReconciliation,
    engineRegistry,
    engineCapabilitySurface,
    pickWorkspaceDirectory: options.pickWorkspaceDirectory,
    fileActionService: new FileActionService({
      openPath: options.openFilePath,
      revealPath: options.revealFilePath
    }),
    errorLogService: new ErrorLogService({
      baseDir: options.persistenceBaseDir,
      now: options.now
    }),
    diagnosticLogService: new DiagnosticLogService({
      baseDir: options.persistenceBaseDir,
      now: options.now
    }),
    takeoverPresetStore,
    smartTakeoverService
  });
};

export const createCodexWorkbenchRuntimeService = (
  options: CreateWorkbenchRuntimeServiceOptions = {}
) => createWorkbenchRuntimeService(options);
