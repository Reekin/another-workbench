import { describe, expect, it, vi } from "vitest";
import type { ExecutionPreferencesByEngineId } from "@another-workbench/shared";
import { WorkbenchShellService } from "../src/workbench-shell-service.js";

const savedExecutionPreferences: ExecutionPreferencesByEngineId = {
  codex: {
    selectedModelId: "gpt-5.5-codex",
    modelPreferences: {
      "gpt-5.5-codex": { reasoningOptionId: "high" }
    }
  }
};

const buildSessionSnapshot = (sessionId = "session-1") => ({
  conversations: [
    {
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      participantEngineIds: ["codex"],
      activeSessionId: sessionId,
      sessionIds: [sessionId],
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z"
    }
  ],
  sessions: [
    {
      sessionId,
      conversationId: "conversation-1",
      engineId: "codex",
      status: "idle",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z"
    }
  ],
  turns: [
    {
      turnId: "turn-1",
      sessionId,
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-04-19T00:00:00.000Z",
      completedAt: "2026-04-19T00:00:02.000Z",
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: []
    },
    {
      turnId: "turn-2",
      sessionId,
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-04-19T00:01:00.000Z",
      completedAt: "2026-04-19T00:01:02.000Z",
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: []
    }
  ],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  participants: [
    {
      participantId: "participant-codex",
      conversationId: "conversation-1",
      engineId: "codex",
      displayName: "Codex",
      activeSessionIds: [sessionId],
      joinedAt: "2026-04-19T00:00:00.000Z"
    }
  ],
  sessionRelations: []
});

const buildWorkspaceRegistry = (
  absolutePath = "I:/repo",
  executionPreferencesByEngineId: ExecutionPreferencesByEngineId = {}
) => ({
  ready: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({
    executionPreferencesByEngineId
  }),
  getWorkspace: vi.fn().mockReturnValue({
    workspaceId: "workspace-1",
    absolutePath,
    label: "repo",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  })
});

const buildProjectedProviderOpenHarness = (
  ensureSessionExecutable = vi.fn().mockResolvedValue(true)
) => {
  const snapshot = buildSessionSnapshot();
  const providerSession = {
    ...snapshot.sessions[0],
    metadata: {
      providerKind: "codex-thread",
      providerSessionId: "thread-1"
    }
  };
  const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
  const markSessionRead = vi.fn().mockResolvedValue(undefined);
  const service = new WorkbenchShellService({
    runtimeService: {
      listSessions: () => [providerSession],
      getSnapshot: () => ({
        ...snapshot,
        sessions: [providerSession]
      }),
      getWorkspaceRegistry: () => ({
        setLastActiveSelection
      }),
      getSessionIndexStore: () => ({
        getEntry: () => ({
          sessionId: "session-1",
          workspaceId: "workspace-1",
          providerKind: "codex-thread",
          providerSessionId: "thread-1"
        })
      })
    } as never,
    sessionCatalog: {
      markSessionRead
    } as never,
    sessionActions: {} as never,
    chatTreeProvider: {
      get: vi.fn().mockResolvedValue({
        currentNodeId: "node-2",
        nodes: [{ nodeId: "node-2", turnId: "turn-2" }]
      })
    } as never,
    sessionReconciliation: {
      ensureSessionExecutable
    } as never
  });

  return {
    service,
    ensureSessionExecutable,
    setLastActiveSelection,
    markSessionRead
  };
};

describe("WorkbenchShellService", () => {
  it("serves engine registry and surface from injected engine-control services", () => {
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      engineRegistry: {
        list: () => [
          {
            engineId: "codex",
            displayName: "Codex",
            integrationTier: "native"
          }
        ]
      } as never,
      engineCapabilitySurface: {
        get: (engineId: string) => ({
          engineId,
          sharedCapabilities: ["chat"],
          extensions: []
        })
      } as never
    });

    expect(service.listEngines()).toEqual([
      {
        engineId: "codex",
        displayName: "Codex",
        integrationTier: "native"
      }
    ]);
    expect(service.getEngineSurface("codex")).toEqual({
      engineId: "codex",
      sharedCapabilities: ["chat"],
      extensions: []
    });
  });

  it("reads and updates persisted shell settings through the workspace registry", async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockReturnValue({
      defaultNewSessionEngineId: "pi",
      allowedModelIdsByEngineId: { codex: ["gpt-5.5-codex"] },
      customModelReasoningOptionIdsByEngineId: {
        codex: { "custom-model": ["low", "high"] }
      },
      executionPreferencesByEngineId: savedExecutionPreferences
    });
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const selectEngine = vi.fn().mockReturnValue({
      selectedEngineId: "codex"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          ready,
          getState,
          updateSettings
        }),
        selectEngine
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.getSettings()).resolves.toEqual({
      defaultNewSessionEngineId: "pi",
      engineProgramPathsByEngineId: {},
      engineProgramResolutionsByEngineId: {},
      allowedModelIdsByEngineId: { codex: ["gpt-5.5-codex"] },
      customModelReasoningOptionIdsByEngineId: {
        codex: { "custom-model": ["low", "high"] }
      },
      executionPreferencesByEngineId: savedExecutionPreferences
    });

    getState.mockReturnValue({
      defaultNewSessionEngineId: "codex",
      allowedModelIdsByEngineId: { codex: ["gpt-5.5-codex"] },
      customModelReasoningOptionIdsByEngineId: {
        codex: { "custom-model": ["low", "high"] }
      },
      executionPreferencesByEngineId: savedExecutionPreferences
    });
    await expect(
      service.updateSettings({
        defaultNewSessionEngineId: "codex"
      })
    ).resolves.toEqual({
      defaultNewSessionEngineId: "codex",
      engineProgramPathsByEngineId: {},
      engineProgramResolutionsByEngineId: {},
      allowedModelIdsByEngineId: { codex: ["gpt-5.5-codex"] },
      customModelReasoningOptionIdsByEngineId: {
        codex: { "custom-model": ["low", "high"] }
      },
      executionPreferencesByEngineId: savedExecutionPreferences
    });
    expect(updateSettings).toHaveBeenCalledWith({
      defaultNewSessionEngineId: "codex"
    });
    expect(selectEngine).toHaveBeenCalledWith({
      engineId: "codex"
    });
  });

  it("reports composer capabilities from the injected engine surface and delegates skills listing", async () => {
    const listSkills = vi.fn().mockResolvedValue([
      {
        cwd: "I:/repo",
        name: "task-breakdown",
        description: "Split work into tasks.",
        shortDescription: "Roadmap helper",
        path: "C:/Users/TestUser/.codex/skills/task-breakdown/SKILL.md",
        scope: "user",
        enabled: true
      }
    ]);
    const service = new WorkbenchShellService({
      runtimeService: {
        getSession: (sessionId: string) =>
          sessionId === "session-1"
            ? ({
                sessionId,
                conversationId: "conversation-1",
                engineId: "codex",
                status: "running",
                createdAt: "2026-04-19T00:00:00.000Z",
                updatedAt: "2026-04-19T00:00:00.000Z"
              } as const)
            : undefined
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      engineCapabilitySurface: {
        get: (engineId: string) => ({
          engineId,
          sharedCapabilities: [
            "chat",
            "steer",
            "attachments",
            "checkpoint",
            "diagnostics"
          ],
          extensions: []
        })
      } as never,
      skillsProvider: {
        listSkills
      }
    });

    await expect(service.getChatCapabilities("session-1")).resolves.toEqual({
      supportsSteer: true,
      supportsAttachments: true,
      slashSuggestions: [
        {
          id: "status",
          label: "/status",
          detail: "Summarize the current session state",
          replacement:
            "Summarize the current session status and the next best action."
        },
        {
          id: "checkpoint",
          label: "/checkpoint",
          detail: "Ask for a checkpoint summary",
          replacement:
            "Summarize the available checkpoints and explain what changed since the latest one.",
          sourceCapability: "checkpoint"
        },
        {
          id: "diagnostics",
          label: "/diagnostics",
          detail: "Review diagnostics and suggest the next fix",
          replacement: "Review the current diagnostics and propose the next fix.",
          sourceCapability: "diagnostics"
        }
      ]
    });
    await expect(
      service.listSkills({
        cwds: ["I:/repo"],
        forceReload: true
      })
    ).resolves.toEqual([
      expect.objectContaining({
        name: "task-breakdown",
        enabled: true
      })
    ]);

    expect(listSkills).toHaveBeenCalledWith({
      cwds: ["I:/repo"],
      forceReload: true
    });
  });

  it("allows plain send from a partially hydrated session when full hydration is unavailable", async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: "cmd-send",
      commandType: "sendUserMessage",
      accepted: true
    });
    const ensureSessionLoaded = vi.fn().mockResolvedValue(false);
    const service = new WorkbenchShellService({
      runtimeService: {
        getSession: () => ({
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z"
        }),
        executeCommand
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });
    (
      service as unknown as {
        partiallyHydratedSessionIds: Set<string>;
      }
    ).partiallyHydratedSessionIds.add("session-1");

    await expect(
      service.executeCommand({
        commandId: "cmd-send",
        command: {
          type: "sendUserMessage",
          sessionId: "session-1",
          messageId: "message-1",
          content: "continue",
          attachments: []
        }
      })
    ).resolves.toEqual({
      commandId: "cmd-send",
      commandType: "sendUserMessage",
      accepted: true
    });
    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1", {
      force: true
    });
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it("blocks stateful non-send commands when a partial session cannot be fully hydrated", async () => {
    const executeCommand = vi.fn();
    const ensureSessionLoaded = vi.fn().mockResolvedValue(false);
    const service = new WorkbenchShellService({
      runtimeService: {
        getSession: () => ({
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "running",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z"
        }),
        executeCommand
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });
    (
      service as unknown as {
        partiallyHydratedSessionIds: Set<string>;
      }
    ).partiallyHydratedSessionIds.add("session-1");

    await expect(
      service.executeCommand({
        commandId: "cmd-steer",
        command: {
          type: "steerTurn",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "message-1",
          content: "adjust",
          attachments: []
        }
      })
    ).rejects.toThrow("Session could not be fully loaded: session-1");
    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1", {
      force: true
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("blocks interaction responses when a partial session cannot be fully hydrated", async () => {
    const executeCommand = vi.fn();
    const ensureSessionLoaded = vi.fn().mockResolvedValue(false);
    const service = new WorkbenchShellService({
      runtimeService: {
        getSession: () => ({
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "awaiting_approval",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z"
        }),
        executeCommand
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });
    (
      service as unknown as {
        partiallyHydratedSessionIds: Set<string>;
      }
    ).partiallyHydratedSessionIds.add("session-1");

    await expect(
      service.executeCommand({
        commandId: "cmd-respond-interaction",
        command: {
          type: "respondInteraction",
          sessionId: "session-1",
          requestId: "interaction-1",
          action: "submit",
          answers: {
            confirm: ["yes"]
          }
        }
      })
    ).rejects.toThrow("Session could not be fully loaded: session-1");
    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1", {
      force: true
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("clears partial hydration state when read-session full hydration succeeds", async () => {
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });
    (
      service as unknown as {
        partiallyHydratedSessionIds: Set<string>;
      }
    ).partiallyHydratedSessionIds.add("session-1");

    await expect(
      service.ensureSessionLoadedForRead("session-1", { force: true })
    ).resolves.toBe(true);

    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1", {
      force: true
    });
    expect(service.isSessionPartiallyHydrated("session-1")).toBe(false);
  });

  it("delegates workspace directory picking to the host callback when available", async () => {
    const pickWorkspaceDirectory = vi.fn().mockResolvedValue({
      canceled: false,
      rootPath: "I:\\repo"
    });
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      pickWorkspaceDirectory
    });

    await expect(service.pickWorkspaceDirectory()).resolves.toEqual({
      canceled: false,
      rootPath: "I:\\repo"
    });
    expect(pickWorkspaceDirectory).toHaveBeenCalledTimes(1);
  });

  it("commits workspace registration without starting a provider repair", async () => {
    const workspace = {
      workspaceId: "workspace-new",
      absolutePath: "I:\\repo-new",
      label: "repo-new",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z"
    };
    const registerWorkspace = vi.fn().mockResolvedValue(workspace);
    const repairWorkspaces = vi.fn().mockRejectedValue(new Error("scan failed"));
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({ registerWorkspace })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: { repairWorkspaces } as never
    });

    await expect(service.addWorkspace({ rootPath: "I:\\repo-new" })).resolves.toEqual(
      workspace
    );
    expect(registerWorkspace).toHaveBeenCalledWith({
      absolutePath: "I:\\repo-new",
      label: undefined
    });
    expect(repairWorkspaces).not.toHaveBeenCalled();
  });

  it("removes workspaces from both registry and persisted session index", async () => {
    const removeWorkspace = vi.fn().mockResolvedValue(true);
    const removeIndexedWorkspace = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          removeWorkspace
        }),
        getSessionIndexStore: () => ({
          removeWorkspace: removeIndexedWorkspace
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.removeWorkspace("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      removed: true
    });
    expect(removeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(removeIndexedWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("returns persisted workspace expansion state", async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockReturnValue({
      workspaces: [],
      lastActiveWorkspaceId: "workspace-1",
      lastActiveSessionId: "session-1",
      expandedWorkspaceIds: ["workspace-1", "workspace-2"]
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({ ready, getState })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.listWorkspaces()).resolves.toEqual({
      workspaces: [],
      lastActiveWorkspaceId: "workspace-1",
      lastActiveSessionId: "session-1",
      expandedWorkspaceIds: ["workspace-1", "workspace-2"]
    });
  });

  it("preserves the active session when reselecting the current workspace", async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockReturnValue({
      lastActiveWorkspaceId: "workspace-1",
      lastActiveSessionId: "session-1"
    });
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          ready,
          getState,
          setLastActiveSelection
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.selectWorkspace("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      activeSessionId: "session-1"
    });
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
  });

  it("marks a session as active and read when opening it from the browser tree", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const getChatTree = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-2",
      nodes: [
        {
          nodeId: "node-1",
          label: "turn-1",
          turnId: "turn-1",
          order: 0,
          isCurrent: false
        },
        {
          nodeId: "node-2",
          label: "turn-2",
          turnId: "turn-2",
          order: 1,
          isCurrent: true
        }
      ],
      fetchedAt: "2026-04-19T00:00:00.000Z"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [
          {
            sessionId: "session-1"
          }
        ],
        getSnapshot: () => buildSessionSnapshot(),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {
        get: getChatTree
      } as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });

    await expect(service.openSession("session-1")).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        windowStartTurnId: "turn-1",
        windowEndTurnId: "turn-2",
        hasOlder: false,
        hasNewer: false
      })
    });
    expect(ensureSessionLoaded).not.toHaveBeenCalled();
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
    expect(getChatTree).toHaveBeenCalledWith("session-1");
  });

  it("adds a shell-owned pin action and persists pin state", async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const getState = vi
      .fn()
      .mockReturnValueOnce({ pinnedSessionIds: [] })
      .mockReturnValue({ pinnedSessionIds: ["session-1"] });
    const setSessionPinned = vi.fn().mockResolvedValue(undefined);
    const getPath = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      revision: "revision-1",
      items: []
    });
    const invalidate = vi.fn();
    const listActions = vi.fn().mockResolvedValue([
      { action: "refresh", label: "Refresh" }
    ]);
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          ready,
          getState,
          setSessionPinned
        })
      } as never,
      sessionCatalog: {
        getPath,
        invalidate
      } as never,
      sessionActions: {
        listActions
      } as never,
      chatTreeProvider: {} as never
    });

    await expect(service.getSessionActions("session-1")).resolves.toEqual({
      actions: [
        { action: "pin", label: "Pin" },
        { action: "refresh", label: "Refresh" }
      ]
    });
    await expect(
      service.runSessionAction({ sessionId: "session-1", action: "pin" })
    ).resolves.toEqual({
      action: "pin",
      pinned: true
    });
    await expect(service.getSessionActions("session-1")).resolves.toEqual({
      actions: [
        { action: "unpin", label: "Unpin" },
        { action: "refresh", label: "Refresh" }
      ]
    });
    expect(setSessionPinned).toHaveBeenCalledWith("session-1", true);
    expect(getPath).toHaveBeenCalledWith("session-1");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("ensures a fully projected provider session is executable before activating it", async () => {
    const {
      service,
      ensureSessionExecutable,
      setLastActiveSelection,
      markSessionRead
    } = buildProjectedProviderOpenHarness();

    await expect(service.openSession("session-1")).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1"
      })
    });
    expect(ensureSessionExecutable).toHaveBeenCalledWith("session-1");
    expect(ensureSessionExecutable.mock.invocationCallOrder[0]).toBeLessThan(
      setLastActiveSelection.mock.invocationCallOrder[0]!
    );
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
  });

  it.each([
    {
      label: "returns false",
      ensure: () => Promise.resolve(false),
      error: "This session could not be resumed for sending."
    },
    {
      label: "throws",
      ensure: () => Promise.reject(new Error("resume failed")),
      error: "resume failed"
    }
  ])(
    "does not activate a fully projected provider session when executable reconciliation $label",
    async ({ ensure, error }) => {
      const ensureSessionExecutable = vi.fn(ensure);
      const { service, setLastActiveSelection, markSessionRead } =
        buildProjectedProviderOpenHarness(ensureSessionExecutable);

      await expect(service.openSession("session-1")).rejects.toThrow(error);
      expect(ensureSessionExecutable).toHaveBeenCalledWith("session-1");
      expect(setLastActiveSelection).not.toHaveBeenCalled();
      expect(markSessionRead).not.toHaveBeenCalled();
    }
  );

  it("marks a cached browser session as active and read without reopening its window", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex"
          }
        ],
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1",
            engineId: "codex"
          }),
          listEntries: () => []
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.activateSession("session-1")).resolves.toEqual({
      sessionId: "session-1"
    });
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
  });

  it("keeps the newest cached session activation authoritative when activations overlap", async () => {
    let resolveFirstActivation: (() => void) | undefined;
    const setLastActiveSelection = vi.fn(
      (input: { sessionId?: string }) =>
        input.sessionId === "session-1"
          ? new Promise<void>((resolve) => {
              resolveFirstActivation = resolve;
            })
          : Promise.resolve()
    );
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex"
          },
          {
            sessionId: "session-2",
            conversationId: "conversation-1",
            engineId: "codex"
          }
        ],
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: (sessionId: string) => ({
            sessionId,
            workspaceId: "workspace-1",
            engineId: "codex"
          }),
          listEntries: () => []
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    const staleActivation = service.activateSession("session-1");
    await vi.waitFor(() => {
      expect(setLastActiveSelection).toHaveBeenCalledTimes(1);
    });
    const activeActivation = service.activateSession("session-2");

    expect(setLastActiveSelection).toHaveBeenCalledTimes(1);
    resolveFirstActivation?.();

    await expect(staleActivation).rejects.toThrow("Open session cancelled.");
    await expect(activeActivation).resolves.toEqual({
      sessionId: "session-2"
    });
    expect(setLastActiveSelection).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-2"
    });
    expect(markSessionRead).toHaveBeenCalledTimes(1);
    expect(markSessionRead).toHaveBeenCalledWith("session-2");
  });

  it("opens cold indexed sessions through lightweight window hydration", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const ensureSessionExecutable = vi.fn().mockResolvedValue(true);
    const getChatTree = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      visibleTurnIds: ["turn-2"],
      nodes: []
    });
    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      conversation: buildSessionSnapshot().conversations[0],
      session: buildSessionSnapshot().sessions[0],
      turns: [buildSessionSnapshot().turns[1]],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: true,
      hasNewer: false,
      olderCursor: "older-cursor",
      runtimeBinding: {
        providerKind: "codex-thread",
        providerSessionId: "thread-1"
      }
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [],
        getSnapshot: () => buildSessionSnapshot(),
        getSnapshotResult: () => ({
          snapshot: buildSessionSnapshot(),
          cursor: "runtime-cursor-1"
        }),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1",
            providerKind: "codex-thread",
            providerSessionId: "thread-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {
        get: getChatTree
      } as never,
      sessionReconciliation: {
        ensureSessionLoaded,
        ensureSessionExecutable,
        hydrateSessionWindow
      } as never
    });

    await expect(service.openSession("session-1")).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        cursor: "runtime-cursor-1",
        windowStartTurnId: "turn-2",
        windowEndTurnId: "turn-2",
        hasOlder: true,
        hasNewer: false,
        olderCursor: "older-cursor"
      })
    });
    expect(hydrateSessionWindow).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        limit: expect.any(Number),
        anchorTurnId: "turn-2",
        isCancelled: expect.any(Function)
      })
    );
    expect(getChatTree).toHaveBeenCalledWith("session-1");
    expect(ensureSessionLoaded).not.toHaveBeenCalled();
    expect(ensureSessionExecutable).toHaveBeenCalledWith("session-1");
    expect(hydrateSessionWindow.mock.invocationCallOrder[0]).toBeLessThan(
      ensureSessionExecutable.mock.invocationCallOrder[0]!
    );
    expect(ensureSessionExecutable.mock.invocationCallOrder[0]).toBeLessThan(
      setLastActiveSelection.mock.invocationCallOrder[0]!
    );
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
  });

  it("force-opens loaded sessions through provider window hydration", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const getChatTree = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      visibleTurnIds: ["turn-branch"],
      nodes: []
    });
    const snapshot = buildSessionSnapshot();
    const branchTurn = {
      ...snapshot.turns[0],
      turnId: "turn-branch",
      startedAt: "2026-04-19T00:02:00.000Z",
      completedAt: "2026-04-19T00:02:02.000Z"
    };
    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      conversation: snapshot.conversations[0],
      session: snapshot.sessions[0],
      turns: [branchTurn],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: true,
      hasNewer: false,
      olderCursor: "older-branch"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => snapshot.sessions,
        getSnapshot: () => snapshot,
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {
        get: getChatTree
      } as never,
      sessionReconciliation: {
        hydrateSessionWindow
      } as never
    });

    await expect(
      service.openSession("session-1", {
        forceProviderHydration: true
      })
    ).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        windowStartTurnId: "turn-branch",
        windowEndTurnId: "turn-branch",
        hasOlder: true,
        hasNewer: false,
        olderCursor: "older-branch"
      })
    });
    expect(hydrateSessionWindow).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        limit: expect.any(Number),
        anchorTurnId: "turn-branch",
        isCancelled: expect.any(Function)
      })
    );
    expect(getChatTree).toHaveBeenCalledWith("session-1");
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
  });

  it("hydrates a loaded provider session whose indexed last turn is not projected", async () => {
    const snapshot = buildSessionSnapshot();
    const emptyProviderSession = {
      ...snapshot.sessions[0],
      lastTurnId: "turn-index-only",
      metadata: {
        providerKind: "codex-thread",
        providerSessionId: "sub-thread-1"
      }
    };
    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      conversation: snapshot.conversations[0],
      session: emptyProviderSession,
      turns: [snapshot.turns[0]],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: false,
      hasNewer: false
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [emptyProviderSession],
        getSnapshot: () => ({
          ...snapshot,
          sessions: [emptyProviderSession],
          turns: []
        }),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection: vi.fn().mockResolvedValue(undefined)
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead: vi.fn().mockResolvedValue(undefined)
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {
        get: vi.fn().mockResolvedValue(undefined)
      } as never,
      sessionReconciliation: {
        ensureSessionExecutable: vi.fn().mockResolvedValue(true),
        hydrateSessionWindow
      } as never
    });

    await expect(service.openSession("session-1")).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        windowStartTurnId: "turn-1"
      })
    });
    expect(hydrateSessionWindow).toHaveBeenCalledTimes(1);
  });

  it("hydrates a loaded provider session when the current chat-tree anchor is uncovered", async () => {
    const snapshot = buildSessionSnapshot();
    const providerSession = {
      ...snapshot.sessions[0],
      lastTurnId: "turn-stale",
      metadata: {
        providerKind: "codex-thread",
        providerSessionId: "sub-thread-1"
      }
    };
    const currentTurn = {
      ...snapshot.turns[0],
      turnId: "turn-current",
      sessionId: providerSession.sessionId
    };
    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      conversation: snapshot.conversations[0],
      session: providerSession,
      turns: [currentTurn],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: false,
      hasNewer: false
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [providerSession],
        getSnapshot: () => ({
          ...snapshot,
          sessions: [providerSession],
          turns: [
            {
              ...snapshot.turns[0],
              turnId: "turn-stale",
              sessionId: providerSession.sessionId
            }
          ]
        }),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection: vi.fn().mockResolvedValue(undefined)
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: providerSession.sessionId,
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead: vi.fn().mockResolvedValue(undefined)
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {
        get: vi.fn().mockResolvedValue({
          currentNodeId: "node-current",
          visibleTurnIds: ["turn-current"],
          nodes: [
            {
              nodeId: "node-current",
              turnId: "turn-current"
            }
          ]
        })
      } as never,
      sessionReconciliation: {
        ensureSessionExecutable: vi.fn().mockResolvedValue(true),
        hydrateSessionWindow
      } as never
    });

    await expect(service.openSession(providerSession.sessionId)).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: providerSession.sessionId,
        windowStartTurnId: "turn-current"
      })
    });
    expect(hydrateSessionWindow).toHaveBeenCalledWith(
      providerSession.sessionId,
      expect.objectContaining({
        anchorTurnId: "turn-current"
      })
    );
  });

  it("applies capability operation guards before jumping a lightweight chat tree", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const jumpConversationGraph = vi.fn().mockResolvedValue({
      jumped: true
    });
    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      conversation: buildSessionSnapshot().conversations[0],
      session: buildSessionSnapshot().sessions[0],
      turns: [buildSessionSnapshot().turns[1]],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: true,
      hasNewer: false
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [],
        getSession: (sessionId: string) =>
          buildSessionSnapshot().sessions.find((session) => session.sessionId === sessionId),
        getSnapshot: () => buildSessionSnapshot(),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      capabilities: {
        getOperationGuards: vi.fn().mockReturnValue(["interactive-session"]),
        jumpConversationGraph
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded,
        hydrateSessionWindow
      } as never
    });

    await service.openSession("session-1");
    await expect(
      service.jumpChatTree({
        sessionId: "session-1",
        nodeId: "node-2",
        expectedRevision: 4
      })
    ).resolves.toEqual({
      jumped: true
    });

    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1", {
      force: true
    });
    expect(jumpConversationGraph).toHaveBeenCalledWith("session-1", "node-2", 4);
    expect(ensureSessionLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      jumpConversationGraph.mock.invocationCallOrder[0]
    );
  });

  it("does not activate a stale lightweight open after a newer open cancels it", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    type LightweightHydration = {
      workspaceId: string;
      conversation: ReturnType<typeof buildSessionSnapshot>["conversations"][number];
      session: ReturnType<typeof buildSessionSnapshot>["sessions"][number];
      turns: ReturnType<typeof buildSessionSnapshot>["turns"];
      messageBlocks: [];
      toolCalls: [];
      terminalStreams: [];
      sessionRelations: [];
      hasOlder: boolean;
      hasNewer: boolean;
    };
    let resolveHydration: ((value: LightweightHydration) => void) | undefined;
    const hydrateSessionWindow = vi.fn(
      () =>
        new Promise<LightweightHydration>((resolve) => {
          resolveHydration = resolve;
        })
    );
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [
          {
            sessionId: "session-2"
          }
        ],
        getSnapshot: () => buildSessionSnapshot("session-2"),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: (sessionId: string) => ({
            sessionId,
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        hydrateSessionWindow
      } as never
    });

    const staleOpen = service.openSession("session-1");
    await vi.waitFor(() => {
      expect(hydrateSessionWindow).toHaveBeenCalledTimes(1);
    });
    const activeOpen = service.openSession("session-2");
    const sessionOneSnapshot = buildSessionSnapshot("session-1");
    resolveHydration?.({
      workspaceId: "workspace-1",
      conversation: sessionOneSnapshot.conversations[0],
      session: sessionOneSnapshot.sessions[0],
      turns: [sessionOneSnapshot.turns[0]],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: false,
      hasNewer: false
    });

    await expect(staleOpen).rejects.toThrow("Open session cancelled.");
    await expect(activeOpen).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-2"
      })
    });
    expect(setLastActiveSelection).toHaveBeenCalledTimes(1);
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-2"
    });
    expect(markSessionRead).toHaveBeenCalledTimes(1);
    expect(markSessionRead).toHaveBeenCalledWith("session-2");
  });

  it("passes sessionProfile through when creating a browser session", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "session-created",
      conversationId: "conversation-created"
    });
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        createSession,
        getWorkspaceRegistry: () =>
          buildWorkspaceRegistry("I:/repo", {
            codex: {
              selectedModelId: "persisted-model",
              modelPreferences: {
                "persisted-model": {
                  reasoningOptionId: "low"
                }
              }
            }
          })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(
      service.createBrowserSession({
        workspaceId: "workspace-1",
        engineId: "codex",
        sessionProfile: {
          modeId: "danger-full-access",
          modelId: "explicit-model",
          reasoningOptionId: "xhigh"
        }
      })
    ).resolves.toEqual({
      sessionId: "session-created",
      conversationId: "conversation-created"
    });

    expect(createSession).toHaveBeenCalledWith({
      type: "createSession",
      engineId: "codex",
      workspaceId: "workspace-1",
      conversationId: undefined,
      sessionProfile: {
        modeId: "danger-full-access",
        modelId: "explicit-model",
        reasoningOptionId: "xhigh"
      },
      metadata: {
        cwd: "I:/repo"
      }
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-created");
  });

  it("inherits the selected engine profile with its explicit model speed", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "session-created",
      conversationId: "conversation-created"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        createSession,
        getWorkspaceRegistry: () =>
          buildWorkspaceRegistry("I:/repo", {
            codex: {
              selectedModelId: "gpt-5.5-codex",
              modelPreferences: {
                "gpt-5.5-codex": {
                  reasoningOptionId: "high",
                  serviceTierId: "priority"
                }
              }
            },
            acp: {
              selectedModelId: "claude-sonnet",
              modelPreferences: {
                "claude-sonnet": {
                  reasoningOptionId: "extra"
                }
              }
            }
          })
      } as never,
      sessionCatalog: {
        markSessionRead: vi.fn().mockResolvedValue(undefined)
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await service.createBrowserSession({
      workspaceId: "workspace-1",
      engineId: "codex"
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        engineId: "codex",
        sessionProfile: {
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "high",
          serviceTierId: "priority"
        }
      })
    );
  });

  it("anchors session opening from provider chat tree truth instead of persisted view state", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const getChatTree = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-4",
      nodes: Array.from({ length: 10 }, (_value, index) => ({
        nodeId: `node-${index + 1}`,
        label: `turn-${index + 1}`,
        turnId: `turn-${index + 1}`,
        order: index,
        isCurrent: index === 3
      })),
      fetchedAt: "2026-04-19T00:00:00.000Z"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [
          {
            sessionId: "session-1"
          }
        ],
        getSnapshot: () => ({
          ...buildSessionSnapshot(),
          turns: Array.from({ length: 10 }, (_value, index) => ({
            turnId: `turn-${index + 1}`,
            sessionId: "session-1",
            status: "completed" as const,
            finishReason: "completed" as const,
            startedAt: `2026-04-19T00:${String(index).padStart(2, "0")}:00.000Z`,
            completedAt: `2026-04-19T00:${String(index).padStart(2, "0")}:10.000Z`,
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }))
        }),
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {
        get: getChatTree
      } as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });

    await expect(service.openSession("session-1")).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        windowStartTurnId: "turn-1",
        windowEndTurnId: "turn-4",
        hasOlder: false,
        hasNewer: true
      })
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
    expect(getChatTree).toHaveBeenCalledWith("session-1");
  });

  it("loads older turns using the paged window contract", async () => {
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const service = new WorkbenchShellService({
      runtimeService: {
        getSnapshot: () => ({
          ...buildSessionSnapshot(),
          turns: [
            {
              turnId: "turn-1",
              sessionId: "session-1",
              status: "completed",
              finishReason: "completed",
              startedAt: "2026-04-19T00:00:00.000Z",
              completedAt: "2026-04-19T00:00:02.000Z",
              messageIds: [],
              toolCallIds: [],
              terminalIds: [],
              approvalRequestIds: []
            },
            {
              turnId: "turn-2",
              sessionId: "session-1",
              status: "completed",
              finishReason: "completed",
              startedAt: "2026-04-19T00:01:00.000Z",
              completedAt: "2026-04-19T00:01:02.000Z",
              messageIds: [],
              toolCallIds: [],
              terminalIds: [],
              approvalRequestIds: []
            },
            {
              turnId: "turn-3",
              sessionId: "session-1",
              status: "completed",
              finishReason: "completed",
              startedAt: "2026-04-19T00:02:00.000Z",
              completedAt: "2026-04-19T00:02:02.000Z",
              messageIds: [],
              toolCallIds: [],
              terminalIds: [],
              approvalRequestIds: []
            }
          ]
        }),
        getWorkspaceRegistry: () => ({
          ready: vi.fn(),
          getState: vi.fn().mockReturnValue({})
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });

    await expect(
      service.loadOlderSessionTurns({
        sessionId: "session-1",
        beforeTurnId: "turn-3",
        limit: 1
      })
    ).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        windowStartTurnId: "turn-2",
        windowEndTurnId: "turn-2",
        hasOlder: true,
        hasNewer: true
      })
    });
    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1", {
      force: false
    });
  });

  it("loads older turns through provider cursors when available", async () => {
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const hydrateSessionWindow = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      conversation: buildSessionSnapshot().conversations[0],
      session: buildSessionSnapshot().sessions[0],
      turns: [buildSessionSnapshot().turns[0]],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: [],
      hasOlder: false,
      hasNewer: true,
      newerCursor: "newer-cursor",
      runtimeBinding: {
        providerKind: "codex-thread",
        providerSessionId: "thread-1"
      }
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        getSnapshot: () => buildSessionSnapshot(),
        getWorkspaceRegistry: () => ({
          ready: vi.fn(),
          getState: vi.fn().mockReturnValue({})
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded,
        hydrateSessionWindow
      } as never
    });

    await expect(
      service.loadOlderSessionTurns({
        sessionId: "session-1",
        cursor: "older-cursor",
        limit: 1
      })
    ).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
        windowStartTurnId: "turn-1",
        windowEndTurnId: "turn-1",
        hasOlder: false,
        hasNewer: true,
        newerCursor: "newer-cursor"
      })
    });
    expect(hydrateSessionWindow).toHaveBeenCalledWith("session-1", {
      limit: 1,
      cursor: "older-cursor"
    });
    expect(ensureSessionLoaded).not.toHaveBeenCalled();
  });

  it("creates browser sessions through the runtime service and returns the concrete session id", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        createSession,
        getWorkspaceRegistry: () => buildWorkspaceRegistry("I:/repo")
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(
      service.createBrowserSession({
        workspaceId: "workspace-1",
        engineId: "codex"
      })
    ).resolves.toEqual({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });
    expect(createSession).toHaveBeenCalledWith({
      type: "createSession",
      workspaceId: "workspace-1",
      engineId: "codex",
      conversationId: undefined,
      metadata: {
        cwd: "I:/repo"
      }
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-new");
  });

  it("rejects opening a stale session entry that has no loadable provider identity", async () => {
    const ensureSessionLoaded = vi.fn().mockResolvedValue(false);
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [],
        getWorkspaceRegistry: () => ({
          setLastActiveSelection: vi.fn()
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-legacy",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead: vi.fn()
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });

    await expect(service.openSession("session-legacy")).rejects.toThrow(
      "This session does not expose a loadable provider session id."
    );
  });

  it("passes workspace filters through to the session catalog", async () => {
    const listWorkspaceTree = vi
      .fn()
      .mockResolvedValue([{ workspaceId: "workspace-1", sessions: [] }]);
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {
        listWorkspaceTree
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.listSessionTree("workspace-1")).resolves.toEqual({
      workspaces: [{ workspaceId: "workspace-1", sessions: [] }]
    });
    expect(listWorkspaceTree).toHaveBeenCalledWith("workspace-1");
  });

  it("forwards explicit repair requests to the session discovery service", async () => {
    const repairWorkspaces = vi.fn().mockResolvedValue({
      workspaces: 1,
      sessions: 3,
      relations: 1
    });
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        repairWorkspaces
      } as never
    });

    await expect(
      service.repairSessionBrowser(["workspace-1", "workspace-2"])
    ).resolves.toEqual({
      workspaces: 1,
      sessions: 3,
      relations: 1
    });
    expect(repairWorkspaces).toHaveBeenCalledWith(["workspace-1", "workspace-2"]);
  });

  it("routes file actions through the injected file service", async () => {
    const runAction = vi.fn().mockResolvedValue({
      action: "open",
      ok: true,
      displayPath: "I:\\repo\\docs\\README.md",
      fileUrl: "file:///I:/repo/docs/README.md"
    });
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      fileActionService: {
        runAction
      } as never
    });

    await expect(
      service.runFileAction({
        path: "I:\\repo\\docs\\README.md",
        action: "open"
      })
    ).resolves.toEqual({
      result: {
        action: "open",
        ok: true,
        displayPath: "I:\\repo\\docs\\README.md",
        fileUrl: "file:///I:/repo/docs/README.md"
      }
    });

    expect(runAction).toHaveBeenCalledWith({
      path: "I:\\repo\\docs\\README.md",
      action: "open"
    });
  });

  it("routes codex turn-change data and undo through the injected extension service", async () => {
    const getTurnChanges = vi.fn().mockResolvedValue({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-2",
      changedFiles: [
        {
          path: "I:\\repo\\src\\foo.ts",
          displayPath: "I:\\repo\\src\\foo.ts",
          fileUrl: "file:///I:/repo/src/foo.ts",
          label: "foo.ts",
          fileName: "foo.ts",
          extension: "ts",
          isImage: false,
          source: "inline_path",
          changeKind: "update",
          diff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`
        }
      ],
      canUndo: true
    });
    const undoTurnChanges = vi.fn().mockResolvedValue({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-2",
      undone: true,
      displayPath: "I:\\repo"
    });

    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      codexTurnChangesService: {
        getTurnChanges,
        undoTurnChanges
      } as never
    });

    await expect(
      service.getCodexTurnChanges({
        sessionId: "session-1",
        turnId: "turn-2"
      })
    ).resolves.toEqual({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-2",
      changedFiles: [
        expect.objectContaining({
          path: "I:\\repo\\src\\foo.ts",
          changeKind: "update"
        })
      ],
      canUndo: true
    });
    await expect(
      service.undoCodexTurnChanges({
        sessionId: "session-1",
        turnId: "turn-2"
      })
    ).resolves.toEqual({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-2",
      undone: true,
      displayPath: "I:\\repo",
      errorMessage: undefined
    });
    expect(getTurnChanges).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-2"
    });
    expect(undoTurnChanges).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-2"
    });
  });
});
