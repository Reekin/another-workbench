import { describe, expect, it, vi } from "vitest";
import { WorkbenchShellService } from "../src/workbench-shell-service.js";

const buildSessionSnapshot = (sessionId = "session-1") => ({
  conversations: [
    {
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      participantAgentIds: ["codex"],
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
      agentId: "codex",
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
      agentId: "codex",
      displayName: "Codex",
      activeSessionIds: [sessionId],
      joinedAt: "2026-04-19T00:00:00.000Z"
    }
  ],
  sessionRelations: []
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
      defaultNewSessionAgentId: "pi"
    });
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const selectAgent = vi.fn().mockReturnValue({
      selectedAgentId: "codex"
    });
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          ready,
          getState,
          updateSettings
        }),
        selectAgent
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.getSettings()).resolves.toEqual({
      defaultNewSessionAgentId: "pi"
    });

    getState.mockReturnValue({
      defaultNewSessionAgentId: "codex"
    });
    await expect(
      service.updateSettings({
        defaultNewSessionAgentId: "codex"
      })
    ).resolves.toEqual({
      defaultNewSessionAgentId: "codex"
    });
    expect(updateSettings).toHaveBeenCalledWith({
      defaultNewSessionAgentId: "codex"
    });
    expect(selectAgent).toHaveBeenCalledWith({
      agentId: "codex"
    });
  });

  it("reports steer capability from the active session agent and delegates skills listing", async () => {
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
                agentId: "codex",
                status: "running",
                createdAt: "2026-04-19T00:00:00.000Z",
                updatedAt: "2026-04-19T00:00:00.000Z"
              } as const)
            : undefined
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      skillsProvider: {
        listSkills
      }
    });

    await expect(service.getChatCapabilities("session-1")).resolves.toEqual({
      supportsSteer: true,
      supportsAttachments: true
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
      agentId: "codex",
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
    expect(ensureSessionLoaded).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        isCancelled: expect.any(Function)
      })
    );
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
    expect(getChatTree).toHaveBeenCalledWith("session-1");
  });

  it("passes sessionProfile through when creating a browser session", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "session-created",
      conversationId: "conversation-created"
    });
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        createSession
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
        agentId: "codex",
        sessionProfile: {
          engineId: "codex",
          modeId: "danger-full-access"
        }
      })
    ).resolves.toEqual({
      sessionId: "session-created",
      conversationId: "conversation-created"
    });

    expect(createSession).toHaveBeenCalledWith({
      type: "createSession",
      agentId: "codex",
      workspaceId: "workspace-1",
      conversationId: undefined,
      sessionProfile: {
        engineId: "codex",
        modeId: "danger-full-access"
      },
      metadata: undefined
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-created");
  });

  it("anchors session opening from provider chat tree truth instead of persisted view state", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const getChatTree = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      agentId: "codex",
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
    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1");
  });

  it("creates browser sessions through the runtime service and returns the concrete session id", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        createSession
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
        agentId: "codex"
      })
    ).resolves.toEqual({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });
    expect(createSession).toHaveBeenCalledWith({
      type: "createSession",
      workspaceId: "workspace-1",
      agentId: "codex",
      conversationId: undefined,
      metadata: undefined
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
});
