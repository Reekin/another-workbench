import {
  createAcpAdapter,
  createCodexAdapter
} from "@another-workbench/adapters";
import type {
  RuntimeEventFilter,
  RuntimeEventReplayInput
} from "@another-workbench/core";
import type {
  ChatInteractionCapabilitiesRpc,
  ChatTreeSnapshotRpc,
  CommandEnvelope,
  DiagnosticsSnapshotRpc,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  EventEnvelope,
  TakeoverSessionStateRpc,
  WorkbenchSettingsRpc,
  WorkspaceBrowserNodeRpc,
  WorkspaceRecordRpc,
  DomainSnapshot
} from "@another-workbench/shared";
import { createAcpDemoRuntimePort, createCodexDemoRuntimePort } from "./demo-runtime-port.js";
import { WorkbenchRuntimeService } from "./runtime-service.js";
import { buildSessionWindowSnapshot } from "./session-window.js";
import {
  SessionBrowserReadModel,
  type SessionBrowserReadModelSeed
} from "./session-browser-read-model.js";

export const createDemoWorkbenchRuntimeService = () => {
  const codexAgentId = "codex";
  const acpAgentId = "acp";

  const service = new WorkbenchRuntimeService({
    agentBindings: [
      {
        descriptor: {
          engineId: codexAgentId,
          displayName: "Codex",
          capabilities: ["chat", "tool", "terminal", "approval"]
        },
        adapter: createCodexAdapter(createCodexDemoRuntimePort(codexAgentId), {
          id: codexAgentId,
          fallbackAgentId: codexAgentId
        })
      },
      {
        descriptor: {
          engineId: acpAgentId,
          displayName: "ACP",
          capabilities: ["chat", "tool", "terminal", "approval"]
        },
        adapter: createAcpAdapter(createAcpDemoRuntimePort(acpAgentId), {
          id: acpAgentId,
          fallbackAgentId: acpAgentId
        })
      }
    ]
  });

  return service;
};

const demoWorkspace: WorkspaceRecordRpc = {
  workspaceId: "workspace-demo",
  absolutePath: "demo://workspace",
  label: "Demo Workspace",
  createdAt: "2026-04-17T00:00:00.000Z",
  updatedAt: "2026-04-17T00:00:00.000Z"
};

const demoEngines: EngineDefinitionRpc[] = [
  {
    engineId: "codex",
    displayName: "Codex",
    integrationTier: "native",
    transportKind: "demo"
  },
  {
    engineId: "acp",
    displayName: "ACP",
    integrationTier: "native",
    transportKind: "demo"
  }
];

const demoEngineSurface = (engineId: string): EngineSurfaceRpc => ({
  engineId,
  sharedCapabilities: ["chat", "tool", "terminal", "approval"],
  extensions: []
});

const sortByUpdatedAtDesc = <
  T extends {
    updatedAt?: string;
    sessionId: string;
  }
>(
  items: T[]
): T[] =>
  [...items].sort((left, right) => {
    const byUpdatedAt = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });

export type DemoWorkbenchShellServiceOptions = {
  initialSnapshotMode?: "full" | "sessionsOnly";
};

const sessionsOnlySnapshot = (snapshot: DomainSnapshot): DomainSnapshot => ({
  ...snapshot,
  turns: [],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  runtimeInteractions: [],
  threadGoals: []
});

export const createDemoWorkbenchShellService = (
  options: DemoWorkbenchShellServiceOptions = {}
) => {
  const service = createDemoWorkbenchRuntimeService();
  const expandedWorkspaceIds = new Set([demoWorkspace.workspaceId]);
  const expandedSessionIds = new Set<string>();
  const settings: WorkbenchSettingsRpc = {
    defaultNewSessionEngineId: "acp"
  };
  let lastActiveWorkspaceId: string | undefined = demoWorkspace.workspaceId;
  let lastActiveSessionId: string | undefined;

  const now = () => new Date().toISOString();
  const resolveSession = (sessionId: string) => {
    const snapshot = service.getSnapshot();
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
    return {
      snapshot,
      session,
      conversation
    };
  };

  const activateSession = (sessionId: string): void => {
    const { conversation } = resolveSession(sessionId);
    lastActiveWorkspaceId = conversation.workspaceId ?? demoWorkspace.workspaceId;
    lastActiveSessionId = sessionId;
  };

  const resolveCreatedSessionId = (command: CommandEnvelope["command"]): string => {
    if (command.type !== "createSession") {
      throw new Error("Expected a createSession command.");
    }
    const snapshot = service.getSnapshot();
    const session = sortByUpdatedAtDesc(
      snapshot.sessions.filter(
        (item) =>
          item.engineId === command.engineId &&
          (!command.conversationId || item.conversationId === command.conversationId)
      )
    )[0];
    if (!session) {
      throw new Error(`Demo session was not created for ${command.engineId}.`);
    }
    return session.sessionId;
  };

  const buildWindow = (
    sessionId: string,
    input: {
      limit: number;
      beforeTurnId?: string;
    }
  ) => {
    const snapshotResult = service.getSnapshotResult();
    const { snapshot, session, conversation } = resolveSession(sessionId);
    return buildSessionWindowSnapshot({
      sessionId,
      cursor: snapshotResult.cursor,
      conversation,
      session,
      turns: snapshot.turns.filter((turn) => turn.sessionId === sessionId),
      messageBlocks: snapshot.messageBlocks.filter(
        (block) => block.sessionId === sessionId
      ),
      toolCalls: snapshot.toolCalls.filter(
        (toolCall) => toolCall.sessionId === sessionId
      ),
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
      beforeTurnId: input.beforeTurnId
    });
  };

  const toSessionNode = (
    session: ReturnType<WorkbenchRuntimeService["listSessions"]>[number]
  ): WorkspaceBrowserNodeRpc["sessions"][number] => ({
    sessionId: session.sessionId,
    displaySessionId: session.sessionId,
    workspaceId: demoWorkspace.workspaceId,
    conversationId: session.conversationId,
    engineId: session.engineId,
    title: session.title ?? `${session.engineId.toUpperCase()} Demo Session`,
    statusDot: session.status === "running" ? "running" : "none",
    isExpanded: expandedSessionIds.has(session.sessionId),
    isActive: lastActiveSessionId === session.sessionId,
    isArchived: Boolean(session.archivedAt),
    children: [],
    updatedAt: session.updatedAt,
    lastCompletedTurnAt:
      service
        .getSnapshot()
        .turns.filter(
          (turn) => turn.sessionId === session.sessionId && turn.completedAt
        )
        .sort((left, right) =>
          (right.completedAt ?? "").localeCompare(left.completedAt ?? "")
        )[0]?.completedAt
  });

  const buildSessionBrowserReadModel = (): SessionBrowserReadModel => {
    const snapshot = service.getSnapshot();
    const parentByChildId = new Map(
      snapshot.sessionRelations.map((relation) => [
        relation.childSessionId,
        relation.parentSessionId
      ] as const)
    );
    const childCountByParentId = new Map<string, number>();
    for (const parentSessionId of parentByChildId.values()) {
      childCountByParentId.set(
        parentSessionId,
        (childCountByParentId.get(parentSessionId) ?? 0) + 1
      );
    }
    const seeds: SessionBrowserReadModelSeed[] = snapshot.sessions
      .filter((session) => !session.archivedAt)
      .map((session) => {
        const lastCompletedTurnAt = snapshot.turns
          .filter((turn) => turn.sessionId === session.sessionId && turn.completedAt)
          .sort((left, right) =>
            (right.completedAt ?? "").localeCompare(left.completedAt ?? "")
          )[0]?.completedAt;
        return {
          sessionId: session.sessionId,
          parentSessionId: parentByChildId.get(session.sessionId),
          workspaceId: demoWorkspace.workspaceId,
          engineId: session.engineId,
          title: session.title ?? `${session.engineId.toUpperCase()} Demo Session`,
          statusDot: session.status === "running" ? "running" : "none",
          isActive: lastActiveSessionId === session.sessionId,
          childCount: childCountByParentId.get(session.sessionId) ?? 0,
          lastCompletedTurnAt,
          sortAt: lastCompletedTurnAt ?? session.updatedAt ?? session.createdAt
        };
      });
    return new SessionBrowserReadModel(seeds);
  };

  const unsupportedChatTree = (sessionId: string): ChatTreeSnapshotRpc => {
    const { session } = resolveSession(sessionId);
    return {
      sessionId,
      engineId: session.engineId,
      supportsJump: false,
      nodes: [],
      fetchedAt: now()
    };
  };

  const unsupportedDiagnostics = (sessionId: string): DiagnosticsSnapshotRpc => {
    const { session } = resolveSession(sessionId);
    return {
      sessionId,
      engineId: session.engineId,
      supported: false,
      authenticated: false,
      fetchedAt: now()
    };
  };

  const takeoverState = (sessionId: string): TakeoverSessionStateRpc => ({
    sessionId,
    role: "none",
    active: false
  });

  return {
    executeCommand: async (input: CommandEnvelope) => {
      const receipt = await service.executeCommand(input);
      if (receipt.accepted && input.command.type === "createSession") {
        activateSession(resolveCreatedSessionId(input.command));
      }
      return receipt;
    },
    listSessions: service.listSessions.bind(service),
    getSession: service.getSession.bind(service),
    getSnapshot: service.getSnapshot.bind(service),
    getSnapshotResult: () => {
      const result = service.getSnapshotResult();
      return {
        ...result,
        snapshot:
          options.initialSnapshotMode === "sessionsOnly"
            ? sessionsOnlySnapshot(result.snapshot)
            : result.snapshot
      };
    },
    subscribe: (
      listener: (envelope: EventEnvelope) => void,
      filter: RuntimeEventFilter = {}
    ) => service.subscribe(listener, filter),
    subscribeFromCursor: (
      listener: (envelope: EventEnvelope) => void,
      input: RuntimeEventReplayInput = {}
    ) => service.subscribeFromCursor(listener, input),
    replay: service.replay.bind(service),
    replayResult: service.replayResult.bind(service),
    selectEngine: service.selectEngine.bind(service),
    getSelectedEngineId: service.getSelectedEngineId.bind(service),
    dispose: service.dispose.bind(service),
    listEngines: () => demoEngines,
    getEngineSurface: (engineId: string) => demoEngineSurface(engineId),
    getSettings: async () => ({ ...settings }),
    updateSettings: async (input: WorkbenchSettingsRpc) => {
      settings.defaultNewSessionEngineId = input.defaultNewSessionEngineId;
      return { ...settings };
    },
    listSchedulerTasks: async () => ({
      rootPath: "demo://scheduler",
      tasks: []
    }),
    upsertSchedulerTask: async () => {
      throw new Error("Demo scheduler tasks are read-only.");
    },
    deleteSchedulerTask: async (taskId: string) => ({
      taskId,
      deleted: false
    }),
    listTakeoverPresets: async () => ({
      rootPath: "demo://takeover-presets",
      presets: []
    }),
    readTakeoverPreset: async () => {
      throw new Error("Demo takeover presets are unavailable.");
    },
    upsertTakeoverPreset: async () => {
      throw new Error("Demo takeover presets are read-only.");
    },
    deleteTakeoverPreset: async (presetId: string) => ({
      presetId,
      deleted: false
    }),
    getTakeoverState: (input: { sessionId: string }) => takeoverState(input.sessionId),
    setManualTakeover: async (input: { sessionId: string }) =>
      takeoverState(input.sessionId),
    listWorkspaces: async () => ({
      workspaces: [demoWorkspace],
      lastActiveWorkspaceId,
      lastActiveSessionId
    }),
    pickWorkspaceDirectory: async () => ({
      canceled: true
    }),
    addWorkspace: async () => demoWorkspace,
    removeWorkspace: async (workspaceId: string) => ({
      workspaceId,
      removed: false
    }),
    toggleWorkspaceExpanded: async (workspaceId: string) => {
      if (expandedWorkspaceIds.has(workspaceId)) {
        expandedWorkspaceIds.delete(workspaceId);
      } else {
        expandedWorkspaceIds.add(workspaceId);
      }
      return {
        workspaceId,
        expanded: expandedWorkspaceIds.has(workspaceId)
      };
    },
    selectWorkspace: async (workspaceId: string) => {
      lastActiveWorkspaceId = workspaceId;
      return {
        workspaceId,
        activeSessionId: lastActiveSessionId
      };
    },
    listSessionTree: async (workspaceId?: string) => ({
      workspaces:
        workspaceId && workspaceId !== demoWorkspace.workspaceId
          ? []
          : [
              {
                workspaceId: demoWorkspace.workspaceId,
                label: demoWorkspace.label,
                rootPath: demoWorkspace.absolutePath,
                isExpanded: expandedWorkspaceIds.has(demoWorkspace.workspaceId),
                isActive: lastActiveWorkspaceId === demoWorkspace.workspaceId,
                sessions: sortByUpdatedAtDesc(
                  service
                    .getSnapshot()
                    .sessions.filter((session) => !session.archivedAt)
                ).map(toSessionNode)
              }
            ]
    }),
    listSessionRoots: async (input: {
      workspaceId: string;
      cursor?: string;
      limit?: number;
      expectedRevision?: string;
    }) => buildSessionBrowserReadModel().listRoots(input),
    listSessionChildren: async (input: {
      workspaceId: string;
      parentSessionId: string;
      cursor?: string;
      limit?: number;
      expectedRevision?: string;
    }) => buildSessionBrowserReadModel().listChildren(input),
    getSessionBrowserPath: async (sessionId: string) =>
      buildSessionBrowserReadModel().getPath(sessionId),
    reconcileSessionBrowser: async () => ({
      workspaces: 1,
      sessions: service.getSnapshot().sessions.length,
      relations: service.getSnapshot().sessionRelations.length
    }),
    toggleSessionExpanded: async (sessionId: string) => {
      if (expandedSessionIds.has(sessionId)) {
        expandedSessionIds.delete(sessionId);
      } else {
        expandedSessionIds.add(sessionId);
      }
      return {
        sessionId,
        expanded: expandedSessionIds.has(sessionId)
      };
    },
    createBrowserSession: async (input: {
      workspaceId: string;
      engineId: string;
      conversationId?: string;
    }) => {
      const command: CommandEnvelope = {
        commandId: `demo-create-${Date.now().toString(36)}`,
        command: {
          type: "createSession",
          workspaceId: input.workspaceId,
          engineId: input.engineId,
          conversationId: input.conversationId
        }
      };
      const receipt = await service.executeCommand(command);
      if (!receipt.accepted) {
        throw new Error("Demo session create was rejected.");
      }
      const sessionId = resolveCreatedSessionId(command.command);
      activateSession(sessionId);
      const { session } = resolveSession(sessionId);
      return {
        sessionId,
        conversationId: session.conversationId
      };
    },
    openSession: async (sessionId: string) => {
      activateSession(sessionId);
      return {
        page: buildWindow(sessionId, {
          limit: 8
        })
      };
    },
    activateSession: async (sessionId: string) => {
      activateSession(sessionId);
      return {
        sessionId
      };
    },
    loadOlderSessionTurns: async (input: {
      sessionId: string;
      beforeTurnId?: string;
      limit?: number;
    }) => ({
      page: buildWindow(input.sessionId, {
        limit: input.limit ?? 8,
        beforeTurnId: input.beforeTurnId
      })
    }),
    getSessionActions: async () => ({
      actions: []
    }),
    runSessionAction: async () => ({
      action: "refresh" as const,
      refreshed: true
    }),
    getChatCapabilities: async (): Promise<ChatInteractionCapabilitiesRpc> => ({
      supportsSteer: false,
      supportsAttachments: true,
      slashSuggestions: []
    }),
    listSkills: async () => ({
      skills: []
    }),
    getChatTree: async (sessionId: string) => unsupportedChatTree(sessionId),
    jumpChatTree: async () => ({
      jumped: false
    }),
    getDelegation: async (sessionId: string) => {
      const { session } = resolveSession(sessionId);
      return {
        sessionId,
        engineId: session.engineId,
        supported: false,
        supportsControl: false,
        nodes: [],
        edges: [],
        fetchedAt: now()
      };
    },
    getWorktree: async (sessionId: string) => {
      const { session } = resolveSession(sessionId);
      return {
        sessionId,
        engineId: session.engineId,
        supported: false,
        fetchedAt: now()
      };
    },
    getCheckpoint: async (sessionId: string) => {
      const { session } = resolveSession(sessionId);
      return {
        sessionId,
        engineId: session.engineId,
        supported: false,
        supportsRestore: false,
        checkpoints: [],
        fetchedAt: now()
      };
    },
    getDiagnostics: async (sessionId: string) => unsupportedDiagnostics(sessionId),
    getBackgroundRun: async (sessionId: string) => {
      const { session } = resolveSession(sessionId);
      return {
        sessionId,
        engineId: session.engineId,
        supported: false,
        status: "unsupported" as const,
        fetchedAt: now()
      };
    },
    writeDiagnosticLog: async () => ({
      logged: true as const,
      entryId: `demo-diagnostic-${Date.now().toString(36)}`,
      logPath: "demo://diagnostics"
    }),
    writeErrorLog: async () => ({
      logged: true as const,
      entryId: `demo-error-${Date.now().toString(36)}`,
      logPath: "demo://errors"
    }),
    searchWorkspaceFiles: async () => ({
      results: []
    })
  };
};
