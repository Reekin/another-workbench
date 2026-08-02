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
    engines: [
      {
        engineId: "codex",
        displayName: "Codex",
        capabilities: ["chat"]
      }
    ]
  });

describe("createRemoteRpcHandler", () => {
  it("serves desktop-ipc-compatible engine and session requests", async () => {
    const runtimeService = createService();
    const shellService = {
      executeCommand: runtimeService.executeCommand.bind(runtimeService),
      listSessions: runtimeService.listSessions.bind(runtimeService),
      getSnapshotResult: runtimeService.getSnapshotResult.bind(runtimeService),
      replay: runtimeService.replay.bind(runtimeService),
      selectEngine: runtimeService.selectEngine.bind(runtimeService),
      listEngines: () => [
        {
          engineId: "codex",
          displayName: "Codex",
          integrationTier: "native"
        }
      ],
      getEngineSurface: (engineId: string) => ({
        engineId,
        sharedCapabilities: ["chat"],
        extensions: []
      }),
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: []
      })
    };
    const handler = createRemoteRpcHandler(shellService as never, {
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
            engineId: "codex"
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

    const listEnginesResponse = await handler.handleRequest({
      id: "req-engines",
      method: "engine.list",
      params: {}
    });

    expect(listEnginesResponse).toMatchObject({
      id: "req-engines",
      method: "engine.list",
      ok: true,
      result: {
        engines: [
          {
            engineId: "codex",
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
            engineId: "codex"
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
            engineId: "codex"
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
        status: "ok",
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

  it("returns an explicit replay gap when the requested cursor is unavailable", async () => {
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
            engineId: "codex"
          }
        }
      }
    });

    const replayResponse = await handler.handleRequest({
      id: "req-replay-gap",
      method: "events.replay",
      params: {
        fromCursor: "cursor-missing"
      }
    });

    expect(replayResponse).toMatchObject({
      id: "req-replay-gap",
      method: "events.replay",
      ok: true,
      result: {
        status: "gap",
        reason: "cursor_not_found",
        replayed: 0,
        fromCursor: "cursor-missing",
        envelopes: []
      }
    });
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
            engineId: "codex",
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

  it("returns shared error envelopes for invalid engine operations", async () => {
    const service = createService();
    const handler = createRemoteRpcHandler(service);

    const response = await handler.handleRequest({
      id: "req-select",
      method: "engine.select",
      params: {
        engineId: "missing"
      }
    });

    expect(response).toMatchObject({
      id: "req-select",
      method: "engine.select",
      ok: false,
      error: {
        code: "REMOTE_REQUEST_FAILED"
      }
    });
  });

  it("routes typed error log writes to the shell service", async () => {
    const runtimeService = createService();
    const writeErrorLog = vi.fn().mockResolvedValue({
      logged: true,
      entryId: "error-1",
      logPath: "I:\\logs\\errors-2026-04-26.jsonl"
    });
    const handler = createRemoteRpcHandler(
      {
        executeCommand: runtimeService.executeCommand.bind(runtimeService),
        replay: runtimeService.replay.bind(runtimeService),
        listWorkspaces: vi.fn().mockResolvedValue({
          workspaces: []
        }),
        writeErrorLog
      } as never,
      {
        createSubscriptionId: () => "subscription-1"
      }
    );

    const response = await handler.handleRequest({
      id: "req-error-log",
      method: "errorLog.write",
      params: {
        message: "Send failed: boom",
        severity: "error",
        source: "send",
        stack: "Error: boom\n    at send"
      }
    });

    expect(response).toEqual({
      id: "req-error-log",
      method: "errorLog.write",
      ok: true,
      result: {
        logged: true,
        entryId: "error-1",
        logPath: "I:\\logs\\errors-2026-04-26.jsonl"
      }
    });
    expect(writeErrorLog).toHaveBeenCalledWith({
      message: "Send failed: boom",
      severity: "error",
      source: "send",
      stack: "Error: boom\n    at send"
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
        sharedCapabilities: ["chat", "terminal", "worktree"],
        extensions: []
      }),
      selectEngine: () => ({ selectedEngineId: "codex" }),
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
        defaultNewSessionEngineId: "pi"
      }),
      updateSettings: vi.fn().mockResolvedValue({
        defaultNewSessionEngineId: "codex"
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
        defaultNewSessionEngineId: "codex"
      }
    });

    expect(getResponse).toMatchObject({
      id: "req-settings-get",
      method: "settings.get",
      ok: true,
      result: {
        defaultNewSessionEngineId: "pi"
      }
    });
    expect(updateResponse).toMatchObject({
      id: "req-settings-update",
      method: "settings.update",
      ok: true,
      result: {
        defaultNewSessionEngineId: "codex"
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
        sharedCapabilities: ["chat", "approval", "diagnostics"],
        extensions: []
      }),
      selectEngine: () => ({ selectedEngineId: "codex" }),
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
          sharedCapabilities: ["chat", "approval", "diagnostics"],
          extensions: []
        }
      }
    });
  });

  it("routes composer capability and skills RPCs through shell-only APIs", async () => {
    const shellService = {
      selectEngine: vi.fn(),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: []
      }),
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
      getChatCapabilities: vi.fn().mockResolvedValue({
        supportsSteer: true,
        supportsAttachments: true
      }),
      listSkills: vi.fn().mockResolvedValue([
        {
          cwd: "I:/repo",
          name: "task-breakdown",
          description: "Split work into tasks.",
          shortDescription: "Roadmap helper",
          path: "C:/Users/TestUser/.codex/skills/task-breakdown/SKILL.md",
          scope: "user",
          enabled: true
        }
      ])
    };
    const handler = createRemoteRpcHandler(shellService as never);

    await expect(
      handler.handleRequest({
        id: "req-chat-capabilities",
        method: "chat.getCapabilities",
        params: {
          sessionId: "session-1"
        }
      })
    ).resolves.toMatchObject({
      id: "req-chat-capabilities",
      method: "chat.getCapabilities",
      ok: true,
      result: {
        capabilities: {
          supportsSteer: true,
          supportsAttachments: true
        }
      }
    });

    await expect(
      handler.handleRequest({
        id: "req-skills-list",
        method: "skills.list",
        params: {
          cwds: ["I:/repo"],
          forceReload: true
        }
      })
    ).resolves.toMatchObject({
      id: "req-skills-list",
      method: "skills.list",
      ok: true,
      result: {
        skills: [
          expect.objectContaining({
            name: "task-breakdown",
            enabled: true
          })
        ]
      }
    });

    expect(shellService.getChatCapabilities).toHaveBeenCalledWith("session-1");
    expect(shellService.listSkills).toHaveBeenCalledWith({
      cwds: ["I:/repo"],
      forceReload: true
    });
  });

  it("returns websocket endpoint metadata for remote event subscribe and unsubscribe", async () => {
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
      ok: true,
      result: {
        subscriptionId: "subscription-1",
        fromCursor: "3"
      }
    });
    expect(unsubscribeResponse).toMatchObject({
      id: "req-unsubscribe",
      method: "events.unsubscribe",
      ok: true,
      result: {
        unsubscribed: true
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
      setWorkspaceExpanded: vi.fn().mockResolvedValue({
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
      activateSession: vi.fn().mockResolvedValue({
        sessionId: "session-1"
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
        action: "resume",
        resumed: true
      }),
      getChatTree: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        engineId: "codex",
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
        engineId: "codex",
        supported: true,
        workspaceRoot: "I:/repo",
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      getCheckpoint: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        engineId: "codex",
        supported: true,
        supportsRestore: true,
        currentCheckpointId: "node-1",
        checkpoints: [],
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      getDiagnostics: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        engineId: "codex",
        supported: true,
        authenticated: true,
        fetchedAt: "2026-04-18T00:00:00Z"
      }),
      getBackgroundRun: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        engineId: "codex",
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
    const forceOpenSessionResponse = await handler.handleRequest({
      id: "req-open-force",
      method: "sessionBrowser.open",
      params: {
        sessionId: "session-1",
        forceProviderHydration: true
      }
    });
    const activateSessionResponse = await handler.handleRequest({
      id: "req-activate",
      method: "sessionBrowser.activate",
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
    expect(forceOpenSessionResponse).toMatchObject({
      id: "req-open-force",
      method: "sessionBrowser.open",
      ok: true,
      result: {
        page: {
          sessionId: "session-1"
        }
      }
    });
    expect(activateSessionResponse).toMatchObject({
      id: "req-activate",
      method: "sessionBrowser.activate",
      ok: true,
      result: {
        sessionId: "session-1"
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
    expect((shellService as any).openSession).toHaveBeenCalledWith("session-1", {
      forceProviderHydration: true
    });
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
  it("serves file search, preview, and action requests through the shared RPC shape", async () => {
    const shellService = {
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: []
      }),
      searchWorkspaceFiles: vi.fn().mockResolvedValue({
        results: [
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
        ]
      }),
      getFilePreview: vi.fn().mockResolvedValue({
        preview: {
          kind: "text",
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
          text: "# Readme",
          truncated: false,
          lineCount: 1
        }
      }),
      runFileAction: vi.fn().mockResolvedValue({
        result: {
          action: "reveal",
          ok: true,
          displayPath: "I:\\repo\\docs\\README.md",
          fileUrl: "file:///I:/repo/docs/README.md"
        }
      })
    };
    const handler = createRemoteRpcHandler(shellService as never);

    const searchResponse = await handler.handleRequest({
      id: "req-file-search",
      method: "file.searchWorkspace",
      params: {
        workspaceId: "workspace-1",
        query: "readme",
        limit: 5
      }
    });
    const previewResponse = await handler.handleRequest({
      id: "req-file-preview",
      method: "file.getPreview",
      params: {
        path: "I:\\repo\\docs\\README.md"
      }
    });
    const actionResponse = await handler.handleRequest({
      id: "req-file-action",
      method: "file.runAction",
      params: {
        path: "I:\\repo\\docs\\README.md",
        action: "reveal"
      }
    });

    expect(searchResponse).toMatchObject({
      id: "req-file-search",
      method: "file.searchWorkspace",
      ok: true,
      result: {
        results: [
          expect.objectContaining({
            workspaceId: "workspace-1",
            relativePath: "docs\\README.md"
          })
        ]
      }
    });
    expect(previewResponse).toMatchObject({
      id: "req-file-preview",
      method: "file.getPreview",
      ok: true,
      result: {
        preview: expect.objectContaining({
          kind: "text",
          exists: true,
          lineCount: 1
        })
      }
    });
    expect(actionResponse).toMatchObject({
      id: "req-file-action",
      method: "file.runAction",
      ok: true,
      result: {
        result: {
          action: "reveal",
          ok: true,
          displayPath: "I:\\repo\\docs\\README.md"
        }
      }
    });

    expect(shellService.searchWorkspaceFiles).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "readme",
      limit: 5
    });
    expect(shellService.getFilePreview).toHaveBeenCalledWith(
      "I:\\repo\\docs\\README.md"
    );
    expect(shellService.runFileAction).toHaveBeenCalledWith({
      path: "I:\\repo\\docs\\README.md",
      action: "reveal"
    });
  });

  it("serves Codex extension requests through codex-scoped RPC methods", async () => {
    const shellService = {
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: []
      }),
      getCodexHookActivity: vi.fn().mockResolvedValue({
        engineId: "codex",
        sessionId: "session-1",
        turnId: "turn-2",
        runs: [
          {
            id: "hook-1",
            eventName: "preToolUse",
            handlerType: "command",
            executionMode: "sync",
            scope: "turn",
            sourcePath: "I:\\repo\\.codex\\hooks.json",
            source: "project",
            displayOrder: 1,
            status: "completed",
            statusMessage: null,
            startedAt: 1700000000000,
            completedAt: 1700000000025,
            durationMs: 25,
            entries: [
              {
                kind: "warning",
                text: "checked command policy"
              }
            ]
          }
        ]
      }),
      getCodexTurnChanges: vi.fn().mockResolvedValue({
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
+new`
          }
        ],
        canUndo: true
      }),
      undoCodexTurnChanges: vi.fn().mockResolvedValue({
        engineId: "codex",
        sessionId: "session-1",
        turnId: "turn-2",
        undone: true,
        displayPath: "I:\\repo"
      }),
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
      replay: vi.fn().mockReturnValue([])
    };
    const handler = createRemoteRpcHandler(shellService as never);

    const hookResponse = await handler.handleRequest({
      id: "req-codex-hook-activity",
      method: "codex.hookActivity.get",
      params: {
        sessionId: "session-1",
        turnId: "turn-2"
      }
    });
    const getResponse = await handler.handleRequest({
      id: "req-codex-turn-changes",
      method: "codex.turnChanges.get",
      params: {
        sessionId: "session-1",
        turnId: "turn-2"
      }
    });
    const undoResponse = await handler.handleRequest({
      id: "req-codex-turn-changes-undo",
      method: "codex.turnChanges.undo",
      params: {
        sessionId: "session-1",
        turnId: "turn-2"
      }
    });

    expect(hookResponse).toMatchObject({
      id: "req-codex-hook-activity",
      method: "codex.hookActivity.get",
      ok: true,
      result: {
        engineId: "codex",
        sessionId: "session-1",
        turnId: "turn-2",
        runs: [
          expect.objectContaining({
            eventName: "preToolUse",
            status: "completed"
          })
        ]
      }
    });
    expect(getResponse).toMatchObject({
      id: "req-codex-turn-changes",
      method: "codex.turnChanges.get",
      ok: true,
      result: {
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
      }
    });
    expect(undoResponse).toMatchObject({
      id: "req-codex-turn-changes-undo",
      method: "codex.turnChanges.undo",
      ok: true,
      result: {
        engineId: "codex",
        sessionId: "session-1",
        turnId: "turn-2",
        undone: true,
        displayPath: "I:\\repo"
      }
    });
    expect(shellService.getCodexTurnChanges).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-2"
    });
    expect(shellService.getCodexHookActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-2"
    });
    expect(shellService.undoCodexTurnChanges).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-2"
    });
  });

  it("returns typed unavailable errors for file RPCs when shell services are absent", async () => {
    const handler = createRemoteRpcHandler(createService());

    const searchResponse = await handler.handleRequest({
      id: "req-file-search",
      method: "file.searchWorkspace",
      params: {
        workspaceId: "workspace-1",
        query: "readme"
      }
    });
    const previewResponse = await handler.handleRequest({
      id: "req-file-preview",
      method: "file.getPreview",
      params: {
        path: "I:\\repo\\docs\\README.md"
      }
    });
    const actionResponse = await handler.handleRequest({
      id: "req-file-action",
      method: "file.runAction",
      params: {
        path: "I:\\repo\\docs\\README.md",
        action: "open"
      }
    });

    expect(searchResponse).toMatchObject({
      id: "req-file-search",
      method: "file.searchWorkspace",
      ok: false,
      error: {
        code: "FILE_BROWSER_UNAVAILABLE"
      }
    });
    expect(previewResponse).toMatchObject({
      id: "req-file-preview",
      method: "file.getPreview",
      ok: false,
      error: {
        code: "FILE_PREVIEW_UNAVAILABLE"
      }
    });
    expect(actionResponse).toMatchObject({
      id: "req-file-action",
      method: "file.runAction",
      ok: false,
      error: {
        code: "FILE_ACTION_UNAVAILABLE"
      }
    });
  });

  it("returns typed unavailable errors for Codex turn-change RPCs when shell services are absent", async () => {
    const handler = createRemoteRpcHandler(createService());

    const getResponse = await handler.handleRequest({
      id: "req-codex-turn-changes",
      method: "codex.turnChanges.get",
      params: {
        sessionId: "session-1",
        turnId: "turn-2"
      }
    });
    const undoResponse = await handler.handleRequest({
      id: "req-codex-turn-changes-undo",
      method: "codex.turnChanges.undo",
      params: {
        sessionId: "session-1",
        turnId: "turn-2"
      }
    });

    expect(getResponse).toMatchObject({
      id: "req-codex-turn-changes",
      method: "codex.turnChanges.get",
      ok: false,
      error: {
        code: "CODEX_TURN_CHANGES_UNAVAILABLE"
      }
    });
    expect(undoResponse).toMatchObject({
      id: "req-codex-turn-changes-undo",
      method: "codex.turnChanges.undo",
      ok: false,
      error: {
        code: "CODEX_TURN_CHANGES_UNAVAILABLE"
      }
    });
  });
});
