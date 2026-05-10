import { describe, expect, it, vi } from "vitest";
import { WorkbenchShellService } from "../src/workbench-shell-service.js";

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

const buildWorkspaceRegistry = (absolutePath = "I:/repo") => ({
  ready: vi.fn().mockResolvedValue(undefined),
  getWorkspace: vi.fn().mockReturnValue({
    workspaceId: "workspace-1",
    absolutePath,
    label: "repo",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  })
});

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
      defaultNewSessionEngineId: "pi"
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
      defaultNewSessionEngineId: "pi"
    });

    getState.mockReturnValue({
      defaultNewSessionEngineId: "codex"
    });
    await expect(
      service.updateSettings({
        defaultNewSessionEngineId: "codex"
      })
    ).resolves.toEqual({
      defaultNewSessionEngineId: "codex"
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

  it("opens cold indexed sessions through lightweight window hydration", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
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
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded,
        hydrateSessionWindow
      } as never
    });

    await expect(service.openSession("session-1")).resolves.toEqual({
      page: expect.objectContaining({
        sessionId: "session-1",
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
        isCancelled: expect.any(Function)
      })
    );
    expect(ensureSessionLoaded).not.toHaveBeenCalled();
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
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
        engineId: "codex",
        sessionProfile: {
          modeId: "danger-full-access"
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
        modeId: "danger-full-access"
      },
      metadata: {
        cwd: "I:/repo"
      }
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-created");
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

  it("forwards explicit reconcile requests to the session reconciliation service", async () => {
    const reconcileWorkspace = vi.fn().mockResolvedValue({
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
        reconcileWorkspace
      } as never
    });

    await expect(service.reconcileSessionBrowser("workspace-1")).resolves.toEqual({
      workspaces: 1,
      sessions: 3,
      relations: 1
    });
    expect(reconcileWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("routes file search, preview, and actions through the injected file services", async () => {
    const workspace = {
      workspaceId: "workspace-1",
      absolutePath: "I:\\repo",
      label: "repo",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z"
    };
    const ready = vi.fn().mockResolvedValue(undefined);
    const getWorkspace = vi.fn().mockReturnValue(workspace);
    const searchWorkspace = vi.fn().mockResolvedValue([
      {
        workspaceId: "workspace-1",
        workspaceRoot: "I:\\repo",
        relativePath: "docs\\README.md",
        matchScore: 0.98,
        path: "I:\\repo\\docs\\README.md",
        displayPath: "I:\\repo\\docs\\README.md",
        fileUrl: "file:///I:/repo/docs/README.md",
        label: "README.md",
        fileName: "README.md",
        extension: "md",
        isImage: false,
        source: "inline_path"
      }
    ]);
    const getPreview = vi.fn().mockResolvedValue({
      kind: "code",
      target: {
        path: "I:\\repo\\docs\\README.md",
        displayPath: "I:\\repo\\docs\\README.md",
        fileUrl: "file:///I:/repo/docs/README.md",
        label: "README.md",
        fileName: "README.md",
        extension: "md",
        isImage: false,
        source: "inline_path"
      },
      exists: true,
      mimeType: "text/markdown",
      text: "# Hello",
      truncated: false,
      lineCount: 1,
      language: "markdown"
    });
    const runAction = vi.fn().mockResolvedValue({
      action: "open",
      ok: true,
      displayPath: "I:\\repo\\docs\\README.md",
      fileUrl: "file:///I:/repo/docs/README.md"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          ready,
          getWorkspace
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      fileSearchService: {
        searchWorkspace
      } as never,
      filePreviewService: {
        getPreview
      } as never,
      fileActionService: {
        runAction
      } as never
    });

    await expect(
      service.searchWorkspaceFiles({
        workspaceId: "workspace-1",
        query: "readme",
        limit: 5
      })
    ).resolves.toEqual({
      results: [
        expect.objectContaining({
          path: "I:\\repo\\docs\\README.md",
          relativePath: "docs\\README.md"
        })
      ]
    });
    await expect(service.getFilePreview("I:\\repo\\docs\\README.md")).resolves.toEqual({
      preview: expect.objectContaining({
        kind: "code",
        exists: true,
        language: "markdown"
      })
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

    expect(ready).toHaveBeenCalledTimes(1);
    expect(searchWorkspace).toHaveBeenCalledWith({
      workspace,
      query: "readme",
      limit: 5
    });
    expect(getPreview).toHaveBeenCalledWith("I:\\repo\\docs\\README.md");
    expect(runAction).toHaveBeenCalledWith({
      path: "I:\\repo\\docs\\README.md",
      action: "open"
    });
  });

  it("fails file search when the target workspace is unknown", async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const getWorkspace = vi.fn().mockReturnValue(undefined);
    const searchWorkspace = vi.fn();
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          ready,
          getWorkspace
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      fileSearchService: {
        searchWorkspace
      } as never
    });

    await expect(
      service.searchWorkspaceFiles({
        workspaceId: "workspace-missing",
        query: "readme"
      })
    ).rejects.toThrow("Workspace not found: workspace-missing");
    expect(searchWorkspace).not.toHaveBeenCalled();
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
