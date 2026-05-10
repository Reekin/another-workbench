import { describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "@another-workbench/adapters";
import type { RuntimeEvent } from "@another-workbench/shared";
import { readSessionExecutionProfile } from "@another-workbench/shared";
import { DomainService } from "../src/domain-service.js";
import { RuntimeOrchestrator } from "../src/runtime-orchestrator.js";

const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RuntimeOrchestrator", () => {
  it("initializes adapters once and forwards selected config metadata", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockReturnValue(() => {});
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize,
      executeCommand: vi.fn().mockResolvedValue({
        commandId: "noop",
        commandType: "initialize",
        accepted: true
      }),
      subscribe,
      dispose: vi.fn().mockResolvedValue(undefined)
    };

    let orchestrator: RuntimeOrchestrator | undefined;
    const publishedEvents: RuntimeEvent[] = [];
    const domainService = new DomainService({
      now: () => "2026-04-20T00:02:00Z",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: (event) => {
        publishedEvents.push(event);
      }
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession: vi.fn().mockResolvedValue(undefined),
        syncRelation: vi.fn().mockResolvedValue(undefined),
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection: vi.fn().mockResolvedValue(undefined),
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: (event) => {
        publishedEvents.push(event);
      },
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter
        }
      ]
    });

    orchestrator.selectEngine({
      engineId: "codex",
      config: {
        approvalPolicy: "auto"
      }
    });

    await orchestrator.executeCommand({
      commandId: "init-1",
      command: {
        type: "initialize"
      }
    });
    await orchestrator.executeCommand({
      commandId: "init-2",
      command: {
        type: "initialize"
      }
    });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          selectedConfig: {
            approvalPolicy: "auto"
          }
        })
      })
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(publishedEvents).toEqual([]);
  });

  it("creates sessions and coordinates index plus workspace side effects", async () => {
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const activateSelection = vi.fn().mockResolvedValue(undefined);

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:03:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession,
        syncRelation: vi.fn().mockResolvedValue(undefined),
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection,
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: () => {},
      createConversationId: () => "conversation-1",
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          }
        }
      ]
    });

    const session = await orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1"
    });

    expect(session).toMatchObject({
      sessionId: "session-1",
      conversationId: "conversation-1",
      engineId: "codex"
    });
    expect(syncSession).toHaveBeenCalledWith("session-1");
    expect(activateSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(domainService.getSnapshot()).toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId: "conversation-1",
          workspaceId: "workspace-1"
        })
      ],
      sessions: [
        expect.objectContaining({
          sessionId: "session-1",
          conversationId: "conversation-1"
        })
      ]
    });
  });

  it("forwards session working directories to adapters generically", async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: "send-1",
      commandType: "sendUserMessage",
      accepted: true
    });
    const adapter: AgentAdapter = {
      id: "acp-adapter",
      kind: "acp",
      getLifecycleState: () => "idle",
      initialize: vi.fn().mockResolvedValue(undefined),
      executeCommand,
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn().mockResolvedValue(undefined)
    };

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: () => "2026-04-20T00:04:00Z",
      createSessionId: () => "session-cwd",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession: vi.fn().mockResolvedValue(undefined),
        syncRelation: vi.fn().mockResolvedValue(undefined),
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection: vi.fn().mockResolvedValue(undefined),
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: () => {},
      createConversationId: () => "conversation-cwd",
      agentBindings: [
        {
          descriptor: {
            engineId: "pi-acp",
            displayName: "Pi",
            capabilities: ["chat"]
          },
          adapter
        }
      ]
    });

    const session = await orchestrator.createSession({
      engineId: "pi-acp",
      workspaceId: "workspace-1",
      metadata: {
        cwd: "I:/repo"
      }
    });

    await orchestrator.executeCommand({
      commandId: "send-1",
      command: {
        type: "sendUserMessage",
        sessionId: session.sessionId,
        messageId: "message-1",
        content: "hello",
        attachments: []
      }
    });

    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "sendUserMessage",
          sessionId: "session-cwd",
          cwd: "I:/repo"
        })
      })
    );
  });

  it("generates a title from the first user message without blocking send", async () => {
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const generateTitle = vi.fn().mockResolvedValue("Mini PC research");
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: "send-1",
      commandType: "sendUserMessage",
      accepted: true
    });
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize: vi.fn().mockResolvedValue(undefined),
      executeCommand,
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn().mockResolvedValue(undefined)
    };

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: () => "2026-04-20T00:04:00Z",
      createSessionId: () => "session-title",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession,
        syncRelation: vi.fn().mockResolvedValue(undefined),
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection: vi.fn().mockResolvedValue(undefined),
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: () => {},
      createConversationId: () => "conversation-title",
      titleGenerator: {
        generateTitle
      },
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter
        }
      ]
    });

    const session = await orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1"
    });

    await orchestrator.executeCommand({
      commandId: "send-1",
      command: {
        type: "sendUserMessage",
        sessionId: session.sessionId,
        messageId: "message-1",
        content: "帮我调研低功耗迷你主机 CPU",
        attachments: []
      }
    });
    await flushAsyncWork();

    expect(executeCommand).toHaveBeenCalled();
    expect(generateTitle).toHaveBeenCalledWith({
      content: "帮我调研低功耗迷你主机 CPU",
      attachments: []
    });
    expect(domainService.getSession(session.sessionId)).toMatchObject({
      title: "Mini PC research"
    });
    expect(syncSession).toHaveBeenCalledWith("session-title");

    await orchestrator.executeCommand({
      commandId: "send-2",
      command: {
        type: "sendUserMessage",
        sessionId: session.sessionId,
        messageId: "message-2",
        content: "继续",
        attachments: []
      }
    });
    await flushAsyncWork();

    expect(generateTitle).toHaveBeenCalledTimes(1);
  });

  it("persists a session execution profile snapshot for create and resume flows", async () => {
    const syncSession = vi.fn().mockResolvedValue(undefined);

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:03:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-profile",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession,
        syncRelation: vi.fn().mockResolvedValue(undefined),
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection: vi.fn().mockResolvedValue(undefined),
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: () => {},
      createConversationId: () => "conversation-profile",
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          }
        }
      ]
    });

    const created = await orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1",
      sessionProfile: {
        modeId: "danger-full-access",
        modelId: "gpt-5.1"
      }
    });

    expect(readSessionExecutionProfile(created.metadata)).toEqual({
      engineId: "codex",
      modeId: "danger-full-access",
      modelId: "gpt-5.1"
    });

    const resumed = await orchestrator.resumeSession(created.sessionId);
    expect(readSessionExecutionProfile(resumed.metadata)).toEqual({
      engineId: "codex",
      modeId: "danger-full-access",
      modelId: "gpt-5.1"
    });
    expect(syncSession).toHaveBeenCalledWith("session-profile");
  });

  it("persists adapter-emitted subagent relations into the session index", async () => {
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const syncRelation = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn();
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({
        commandId: "noop",
        commandType: "initialize",
        accepted: true
      }),
      subscribe,
      dispose: vi.fn().mockResolvedValue(undefined)
    };

    let adapterListener:
      | ((envelope: {
          occurredAt: string;
          event: RuntimeEvent;
        }) => void | Promise<void>)
      | undefined;
    subscribe.mockImplementation((listener) => {
      adapterListener = listener;
      return () => {};
    });

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:04:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-root",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession,
        syncRelation,
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection: vi.fn().mockResolvedValue(undefined),
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: () => {},
      createConversationId: () => "conversation-1",
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter
        }
      ]
    });

    await orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1"
    });
    await orchestrator.executeCommand({
      commandId: "init-relations",
      command: {
        type: "initialize"
      }
    });

    expect(adapterListener).toBeTypeOf("function");
    await adapterListener?.({
      occurredAt: "2026-04-20T00:04:10Z",
      event: {
        type: "session.created",
        conversationId: "conversation-1",
        sessionId: "session-child",
        engineId: "codex",
        status: "running",
        relation: {
          relationId: "relation-subagent",
          parentSessionId: "session-root",
          childSessionId: "session-child",
          relationType: "subagent",
          sourceTurnId: "turn-1",
          createdAt: "2026-04-20T00:04:10Z"
        }
      }
    });
    await flushAsyncWork();

    expect(syncSession).toHaveBeenCalledWith("session-child");
    expect(syncRelation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      parentSessionId: "session-root",
      childSessionId: "session-child",
      relationType: "subagent",
      sourceTurnId: "turn-1",
      createdAt: "2026-04-20T00:04:10Z"
    });
  });

  it("does not sync the session index for high-volume output deltas", async () => {
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn();
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({
        commandId: "noop",
        commandType: "initialize",
        accepted: true
      }),
      subscribe,
      dispose: vi.fn().mockResolvedValue(undefined)
    };

    let adapterListener:
      | ((envelope: {
          occurredAt: string;
          event: RuntimeEvent;
        }) => void | Promise<void>)
      | undefined;
    subscribe.mockImplementation((listener) => {
      adapterListener = listener;
      return () => {};
    });

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: () => "2026-04-20T00:05:00Z",
      createSessionId: () => "session-output",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });

    orchestrator = new RuntimeOrchestrator({
      domainService,
      sessionIndexSyncService: {
        syncSession,
        syncRelation: vi.fn().mockResolvedValue(undefined),
        markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
      } as never,
      workspaceSelectionService: {
        activateSelection: vi.fn().mockResolvedValue(undefined),
        selectWorkspace: vi.fn().mockResolvedValue({
          workspaceId: "workspace-1"
        })
      } as never,
      publishRuntimeEvent: () => {},
      createConversationId: () => "conversation-output",
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter
        }
      ]
    });

    await orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1"
    });
    syncSession.mockClear();
    await orchestrator.executeCommand({
      commandId: "init-output",
      command: {
        type: "initialize"
      }
    });

    expect(adapterListener).toBeTypeOf("function");
    for (let index = 0; index < 20; index += 1) {
      adapterListener?.({
        occurredAt: "2026-04-20T00:05:01Z",
        event: {
          type: "terminal.output",
          sessionId: "session-output",
          turnId: "turn-output",
          terminalId: "terminal-output",
          chunk: "x".repeat(1024),
          engineId: "codex"
        }
      });
    }
    adapterListener?.({
      occurredAt: "2026-04-20T00:05:02Z",
      event: {
        type: "session.updated",
        conversationId: "conversation-output",
        sessionId: "session-output",
        status: "idle"
      }
    });
    await flushAsyncWork();
    await orchestrator.dispose();

    expect(domainService.getSession("session-output")?.status).toBe("idle");
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith("session-output");
  });
});
