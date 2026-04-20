import { describe, expect, it, vi } from "vitest";
import { createRemoteRpcHandler } from "../src/remote-protocol.js";
import { WorkbenchRuntimeService } from "../src/runtime-service.js";

const createService = () =>
  new WorkbenchRuntimeService({
    now: (() => {
      let tick = 0;
      return () => `2026-04-18T00:10:${String(++tick).padStart(2, "0")}Z`;
    })(),
    createConversationId: (() => {
      let index = 0;
      return () => `conversation-${++index}`;
    })(),
    createRelationId: (() => {
      let index = 0;
      return () => `relation-${++index}`;
    })(),
    createSessionId: (() => {
      let index = 0;
      return () => `session-${++index}`;
    })(),
    createEventId: (() => {
      let index = 0;
      return () => `event-${++index}`;
    })(),
    agents: [
      {
        agentId: "codex",
        displayName: "Codex",
        capabilities: ["chat"]
      }
    ]
  });

describe("createRemoteRpcHandler", () => {
  it("serves desktop-ipc-compatible agent and session requests", async () => {
    const service = createService();
    const handler = createRemoteRpcHandler(service, {
      createSubscriptionId: () => "subscription-1"
    });

    const createSessionResponse = await handler.handleRequest({
      id: "req-create",
      method: "runtime.command",
      params: {
        envelope: {
          commandId: "cmd-create",
          command: {
            type: "createSession",
            agentId: "codex"
          }
        }
      }
    });

    expect(createSessionResponse).toMatchObject({
      id: "req-create",
      method: "runtime.command",
      ok: true,
      result: {
        commandId: "cmd-create",
        commandType: "createSession",
        accepted: true
      }
    });

    const listAgentsResponse = await handler.handleRequest({
      id: "req-agents",
      method: "agent.list",
      params: {}
    });

    expect(listAgentsResponse).toMatchObject({
      id: "req-agents",
      method: "agent.list",
      ok: true,
      result: {
        agents: [
          {
            agentId: "codex",
            displayName: "Codex"
          }
        ]
      }
    });

    const listSessionsResponse = await handler.handleRequest({
      id: "req-sessions",
      method: "session.list",
      params: {
        includeArchived: false
      }
    });

    expect(listSessionsResponse).toMatchObject({
      id: "req-sessions",
      method: "session.list",
      ok: true,
      result: {
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            agentId: "codex"
          }
        ]
      }
    });
  });

  it("replays event envelopes through the shared replay response shape", async () => {
    const service = createService();
    const handler = createRemoteRpcHandler(service, {
      createSubscriptionId: () => "subscription-1"
    });

    await handler.handleRequest({
      id: "req-create",
      method: "runtime.command",
      params: {
        envelope: {
          commandId: "cmd-create",
          command: {
            type: "createSession",
            agentId: "codex"
          }
        }
      }
    });

    const replayResponse = await handler.handleRequest({
      id: "req-replay",
      method: "events.replay",
      params: {
        fromCursor: "2",
        filter: {
          conversationId: "conversation-1"
        }
      }
    });

    expect(replayResponse).toMatchObject({
      id: "req-replay",
      method: "events.replay",
      ok: true,
      result: {
        replayed: 1,
        fromCursor: "2"
      }
    });
    if (replayResponse.ok && replayResponse.method === "events.replay") {
      expect(replayResponse.result.envelopes.map((item) => item.event.type)).toEqual([
        "conversation.updated"
      ]);
    }
  });

  it("returns a typed domain snapshot with the latest cursor", async () => {
    const service = createService();
    const handler = createRemoteRpcHandler(service);

    await handler.handleRequest({
      id: "req-create",
      method: "runtime.command",
      params: {
        envelope: {
          commandId: "cmd-create",
          command: {
            type: "createSession",
            agentId: "codex",
            conversationId: "conversation-1"
          }
        }
      }
    });

    const snapshotResponse = await handler.handleRequest({
      id: "req-snapshot",
      method: "domain.snapshot",
      params: {}
    });

    expect(snapshotResponse).toMatchObject({
      id: "req-snapshot",
      method: "domain.snapshot",
      ok: true,
      result: {
        cursor: "3"
      }
    });
    if (snapshotResponse.ok && snapshotResponse.method === "domain.snapshot") {
      expect(snapshotResponse.result.snapshot.sessions).toEqual([
        expect.objectContaining({
          sessionId: "session-1",
          conversationId: "conversation-1"
        })
      ]);
    }
  });

  it("returns shared error envelopes for invalid agent operations", async () => {
    const service = createService();
    const handler = createRemoteRpcHandler(service);

    const response = await handler.handleRequest({
      id: "req-select",
      method: "agent.select",
      params: {
        agentId: "missing"
      }
    });

    expect(response).toMatchObject({
      id: "req-select",
      method: "agent.select",
      ok: false,
      error: {
        code: "REMOTE_REQUEST_FAILED"
      }
    });
  });

  it("serves settings get and update through the shared RPC shape", async () => {
    const shellService = {
      listEngines: () => [
        {
          engineId: "codex",
          displayName: "Codex",
          integrationTier: "native"
        }
      ],
      getEngineSurface: () => ({
        engineId: "codex",
        sharedCapabilities: ["chat", "terminal"],
        extensions: [
          {
            engineId: "codex",
            key: "worktree",
            displayName: "Worktree Inspector",
            available: true
          }
        ]
      }),
      listAgents: () => [],
      selectAgent: () => ({ selectedAgentId: "codex" }),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: []
      }),
      getSnapshotResult: () => ({
        snapshot: {
          conversations: [],
          sessions: [],
          turns: [],
          messageBlocks: [],
          toolCalls: [],
          terminalStreams: [],
          approvalRequests: [],
          participants: [],
          sessionRelations: []
        }
      }),
      listSessions: () => [],
      getSettings: vi.fn().mockResolvedValue({
        defaultNewSessionAgentId: "pi"
      }),
      updateSettings: vi.fn().mockResolvedValue({
        defaultNewSessionAgentId: "codex"
      }),
      executeCommand: vi.fn(),
      replay: vi.fn().mockReturnValue([])
    };
    const handler = createRemoteRpcHandler(shellService as never);

    const getResponse = await handler.handleRequest({
      id: "req-settings-get",
      method: "settings.get",
      params: {}
    });
    const updateResponse = await handler.handleRequest({
      id: "req-settings-update",
      method: "settings.update",
      params: {
        defaultNewSessionAgentId: "codex"
      }
    });

    expect(getResponse).toMatchObject({
      id: "req-settings-get",
      method: "settings.get",
      ok: true,
      result: {
        defaultNewSessionAgentId: "pi"
      }
    });
    expect(updateResponse).toMatchObject({
      id: "req-settings-update",
      method: "settings.update",
      ok: true,
      result: {
        defaultNewSessionAgentId: "codex"
      }
    });
  });

  it("serves engine registry and engine surface through shared RPC shapes", async () => {
    const shellService = {
      listEngines: () => [
        {
          engineId: "codex",
          displayName: "Codex",
          integrationTier: "native"
        },
        {
          engineId: "pi-acp",
          displayName: "Pi",
          integrationTier: "fallback"
        }
      ],
      getEngineSurface: (engineId: string) => ({
        engineId,
        sharedCapabilities: ["chat", "approval"],
        extensions: [
          {
            engineId,
            key: "diagnostics",
            displayName: "Diagnostics Summary",
            available: engineId === "codex"
          }
        ]
      }),
      listAgents: () => [],
      selectAgent: () => ({ selectedAgentId: "codex" }),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: []
      }),
      getSnapshotResult: () => ({
        snapshot: {
          conversations: [],
          sessions: [],
          turns: [],
          messageBlocks: [],
          toolCalls: [],
          terminalStreams: [],
          approvalRequests: [],
          participants: [],
          sessionRelations: []
        }
      }),
      listSessions: () => [],
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      executeCommand: vi.fn(),
      replay: vi.fn().mockReturnValue([])
    };
    const handler = createRemoteRpcHandler(shellService as never);

    await expect(
      handler.handleRequest({
        id: "req-engines",
        method: "engine.list",
        params: {}
      })
    ).resolves.toMatchObject({
      id: "req-engines",
      method: "engine.list",
      ok: true,
      result: {
        engines: [
          expect.objectContaining({
            engineId: "codex",
            integrationTier: "native"
          }),
          expect.objectContaining({
            engineId: "pi-acp",
            integrationTier: "fallback"
          })
        ]
      }
    });

    await expect(
      handler.handleRequest({
        id: "req-surface",
        method: "engine.getSurface",
        params: {
          engineId: "codex"
        }
      })
    ).resolves.toMatchObject({
      id: "req-surface",
      method: "engine.getSurface",
      ok: true,
      result: {
        surface: {
          engineId: "codex",
          sharedCapabilities: ["chat", "approval"],
          extensions: [
            expect.objectContaining({
              key: "diagnostics"
            })
          ]
        }
      }
    });
  });

  it("requires websocket transport for remote event subscribe and unsubscribe", async () => {
    const service = createService();
    const handler = createRemoteRpcHandler(service, {
      createSubscriptionId: () => "subscription-1"
    });

    const subscribeResponse = await handler.handleRequest({
      id: "req-subscribe",
      method: "events.subscribe",
      params: {
        fromCursor: "3",
        filter: {
          conversationId: "conversation-1"
        }
      }
    });
    const unsubscribeResponse = await handler.handleRequest({
      id: "req-unsubscribe",
      method: "events.unsubscribe",
      params: {
        subscriptionId: "subscription-1"
      }
    });

    expect(subscribeResponse).toMatchObject({
      id: "req-subscribe",
      method: "events.subscribe",
      ok: false,
      error: {
        code: "REMOTE_EVENTS_REQUIRE_WEBSOCKET",
        details: {
          endpoint: "/events",
          subscriptionId: "subscription-1",
          fromCursor: "3"
        }
      }
    });
    expect(unsubscribeResponse).toMatchObject({
      id: "req-unsubscribe",
      method: "events.unsubscribe",
      ok: false,
      error: {
        code: "REMOTE_EVENTS_REQUIRE_WEBSOCKET",
        details: {
          endpoint: "/events",
          subscriptionId: "subscription-1"
        }
      }
    });
  });

  it("routes workspace, session browser, and chat tree requests through shell-only APIs", async () => {
    const shellService = {
      listAgents: vi.fn().mockReturnValue([]),
      selectAgent: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
      getSnapshotResult: vi.fn().mockReturnValue({
        snapshot: {
          conversations: [],
          sessions: [],
          turns: [],
          messageBlocks: [],
          toolCalls: [],
          terminalStreams: [],
          approvalRequests: [],
          participants: [],
          sessionRelations: []
        }
      }),
      executeCommand: vi.fn(),
      replay: vi.fn().mockReturnValue([]),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [],
        lastActiveWorkspaceId: "workspace-1"
      }),
      pickWorkspaceDirectory: vi.fn().mockResolvedValue({
        canceled: false,
        rootPath: "I:/repo"
      }),
      addWorkspace: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        absolutePath: "I:/repo",
        label: "repo",
        createdAt: "2026-04-18T00:00:00Z",
        updatedAt: "2026-04-18T00:00:00Z"
      }),
      removeWorkspace: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        removed: true
      }),
      toggleWorkspaceExpanded: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        expanded: true
      }),
      selectWorkspace: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        activeSessionId: "session-1"
      }),
      listSessionTree: vi.fn().mockResolvedValue({
        workspaces: []
      }),
      reconcileSessionBrowser: vi.fn().mockResolvedValue({
        workspaces: 1,
        sessions: 2,
        relations: 1
      }),
      toggleSessionExpanded: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        expanded: true
      }),
      openSession: vi.fn().mockResolvedValue({
        page: {
          sessionId: "session-1",
          snapshot: {
            conversations: [],
            sessions: [],
            turns: [],
            messageBlocks: [],
            toolCalls: [],
            terminalStreams: [],
            approvalRequests: [],
            participants: [],
            sessionRelations: []
          },
          windowStartTurnId: "turn-2",
          windowEndTurnId: "turn-3",
          hasOlder: true,
          hasNewer: false
        }
      }),
      loadOlderSessionTurns: vi.fn().mockResolvedValue({
        page: {
          sessionId: "session-1",
          snapshot: {
            conversations: [],
            sessions: [],
            turns: [],
            messageBlocks: [],
            toolCalls: [],
            terminalStreams: [],
            approvalRequests: [],
            participants: [],
            sessionRelations: []
          },
          windowStartTurnId: "turn-1",
          windowEndTurnId: "turn-2",
          hasOlder: false,
          hasNewer: true
        }
      }),
      getSessionActions: vi.fn().mockResolvedValue({
        actions: []
      }),
      runSessionAction: vi.fn().mockResolvedValue({
        action: "reload",
        resumed: true
      }),
      getChatTree: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        agentId: "codex",
        supportsJump: true,
        currentNodeId: "node-1",
        nodes: [],
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      jumpChatTree: vi.fn().mockResolvedValue({
        jumped: true
      }),
      getWorktree: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        agentId: "codex",
        supported: true,
        workspaceRoot: "I:/repo",
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      getCheckpoint: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        agentId: "codex",
        supported: true,
        supportsRestore: true,
        currentCheckpointId: "node-1",
        checkpoints: [],
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      getDiagnostics: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        agentId: "codex",
        supported: true,
        authenticated: true,
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      getBackgroundRun: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        agentId: "codex",
        supported: false,
        status: "unsupported",
        fetchedAt: "2026-04-18T00:00:00Z"
      })
    } as unknown as WorkbenchRuntimeService;

    const handler = createRemoteRpcHandler(shellService);

    const listTreeResponse = await handler.handleRequest({
      id: "req-tree",
      method: "sessionBrowser.listTree",
      params: {
        workspaceId: "workspace-1"
      }
    });
    const pickWorkspaceResponse = await handler.handleRequest({
      id: "req-pick-workspace",
      method: "workspace.pickDirectory",
      params: {}
    });
    const reconcileResponse = await handler.handleRequest({
      id: "req-reconcile",
      method: "sessionBrowser.reconcile",
      params: {
        workspaceId: "workspace-1"
      }
    });
    const openSessionResponse = await handler.handleRequest({
      id: "req-open",
      method: "sessionBrowser.open",
      params: {
        sessionId: "session-1"
      }
    });
    const loadOlderResponse = await handler.handleRequest({
      id: "req-load-older",
      method: "sessionBrowser.loadOlder",
      params: {
        sessionId: "session-1",
        beforeTurnId: "turn-3",
        limit: 8
      }
    });
    const removeWorkspaceResponse = await handler.handleRequest({
      id: "req-remove-workspace",
      method: "workspace.remove",
      params: {
        workspaceId: "workspace-1"
      }
    });
    const chatTreeResponse = await handler.handleRequest({
      id: "req-chat-tree",
      method: "chatTree.get",
      params: {
        sessionId: "session-1"
      }
    });
    const worktreeResponse = await handler.handleRequest({
      id: "req-worktree",
      method: "worktree.get",
      params: {
        sessionId: "session-1"
      }
    });
    const checkpointResponse = await handler.handleRequest({
      id: "req-checkpoint",
      method: "checkpoint.get",
      params: {
        sessionId: "session-1"
      }
    });
    const diagnosticsResponse = await handler.handleRequest({
      id: "req-diagnostics",
      method: "diagnostics.get",
      params: {
        sessionId: "session-1"
      }
    });
    const backgroundRunResponse = await handler.handleRequest({
      id: "req-background-run",
      method: "backgroundRun.get",
      params: {
        sessionId: "session-1"
      }
    });

    expect(listTreeResponse).toMatchObject({
      id: "req-tree",
      method: "sessionBrowser.listTree",
      ok: true,
      result: {
        workspaces: []
      }
    });
    expect(pickWorkspaceResponse).toMatchObject({
      id: "req-pick-workspace",
      method: "workspace.pickDirectory",
      ok: true,
      result: {
        canceled: false,
        rootPath: "I:/repo"
      }
    });
    expect(reconcileResponse).toMatchObject({
      id: "req-reconcile",
      method: "sessionBrowser.reconcile",
      ok: true,
      result: {
        workspaces: 1,
        sessions: 2,
        relations: 1
      }
    });
    expect(openSessionResponse).toMatchObject({
      id: "req-open",
      method: "sessionBrowser.open",
      ok: true,
      result: {
        page: {
          sessionId: "session-1",
          windowStartTurnId: "turn-2",
          windowEndTurnId: "turn-3",
          hasOlder: true,
          hasNewer: false
        }
      }
    });
    expect(loadOlderResponse).toMatchObject({
      id: "req-load-older",
      method: "sessionBrowser.loadOlder",
      ok: true,
      result: {
        page: {
          sessionId: "session-1",
          windowStartTurnId: "turn-1",
          windowEndTurnId: "turn-2",
          hasOlder: false,
          hasNewer: true
        }
      }
    });
    expect(removeWorkspaceResponse).toMatchObject({
      id: "req-remove-workspace",
      method: "workspace.remove",
      ok: true,
      result: {
        workspaceId: "workspace-1",
        removed: true
      }
    });
    expect(chatTreeResponse).toMatchObject({
      id: "req-chat-tree",
      method: "chatTree.get",
      ok: true,
      result: {
        chatTree: {
          sessionId: "session-1",
          currentNodeId: "node-1"
        }
      }
    });
    expect(worktreeResponse).toMatchObject({
      id: "req-worktree",
      method: "worktree.get",
      ok: true,
      result: {
        worktree: {
          workspaceRoot: "I:/repo"
        }
      }
    });
    expect(checkpointResponse).toMatchObject({
      id: "req-checkpoint",
      method: "checkpoint.get",
      ok: true,
      result: {
        checkpoint: {
          currentCheckpointId: "node-1"
        }
      }
    });
    expect(diagnosticsResponse).toMatchObject({
      id: "req-diagnostics",
      method: "diagnostics.get",
      ok: true,
      result: {
        diagnostics: {
          authenticated: true
        }
      }
    });
    expect(backgroundRunResponse).toMatchObject({
      id: "req-background-run",
      method: "backgroundRun.get",
      ok: true,
      result: {
        backgroundRun: {
          status: "unsupported"
        }
      }
    });
    expect((shellService as any).listSessionTree).toHaveBeenCalledWith("workspace-1");
    expect((shellService as any).pickWorkspaceDirectory).toHaveBeenCalledTimes(1);
    expect((shellService as any).reconcileSessionBrowser).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect((shellService as any).openSession).toHaveBeenCalledWith("session-1");
    expect((shellService as any).loadOlderSessionTurns).toHaveBeenCalledWith({
      sessionId: "session-1",
      beforeTurnId: "turn-3",
      limit: 8
    });
    expect((shellService as any).removeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect((shellService as any).getChatTree).toHaveBeenCalledWith("session-1");
    expect((shellService as any).getWorktree).toHaveBeenCalledWith("session-1");
    expect((shellService as any).getCheckpoint).toHaveBeenCalledWith("session-1");
    expect((shellService as any).getDiagnostics).toHaveBeenCalledWith("session-1");
    expect((shellService as any).getBackgroundRun).toHaveBeenCalledWith("session-1");
  });
});
