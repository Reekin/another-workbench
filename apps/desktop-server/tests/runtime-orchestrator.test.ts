import { describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "@another-workbench/adapters";
import type { RuntimeEvent } from "@another-workbench/shared";
import { readSessionExecutionProfile } from "@another-workbench/shared";
import { DomainService } from "../src/domain-service.js";
import { RuntimeOrchestrator } from "../src/runtime-orchestrator.js";
import type { WorkbenchAgentBinding } from "../src/runtime-types.js";

const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve,
    reject
  };
};

describe("RuntimeOrchestrator", () => {
  it("preserves full agent binding metadata and shared capability surface", () => {
    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: () => "2026-04-20T00:02:00Z",
      assertEngineRegistered: (engineId) =>
        orchestrator?.assertEngineRegistered(engineId),
      resolveEngineCapabilities: (engineId) =>
        orchestrator?.getEngineCapabilities(engineId) ?? [],
      publishRuntimeEvent: () => {}
    });
    const extension = {
      engineId: "codex",
      key: "changed-files",
      displayName: "Changed Files",
      available: true
    };

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
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat"]
          },
          integrationTier: "native",
          transportKind: "codex",
          providerKind: "codex-thread",
          resolveProviderSessionId: () => "thread-1",
          sharedCapabilities: [
            "chat",
            "attachments",
            "conversationGraph",
            "goal"
          ],
          extensions: [extension]
        }
      ]
    });

    expect(orchestrator.getEngineCapabilities("codex")).toEqual([
      "chat",
      "attachments",
      "conversationGraph",
      "goal"
    ]);

    orchestrator.registerEngine({
      engineId: "codex",
      displayName: "Codex Native",
      capabilities: ["chat"]
    });

    expect(orchestrator.getEngineCapabilities("codex")).toEqual([
      "chat",
      "attachments",
      "conversationGraph",
      "goal"
    ]);
    const binding = (
      orchestrator as unknown as {
        bindings: Map<string, WorkbenchAgentBinding>;
      }
    ).bindings.get("codex");
    expect(binding).toMatchObject({
      integrationTier: "native",
      transportKind: "codex",
      providerKind: "codex-thread",
      extensions: [extension]
    });
    expect(binding?.descriptor.displayName).toBe("Codex Native");
  });

  it("initializes adapters once and forwards selected config metadata", async () => {
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
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

  it("invalidates cached adapter readiness after a runtime failure", async () => {
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
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
    const domainService = new DomainService({
      now: () => "2026-04-20T00:02:00Z",
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

    await orchestrator.executeCommand({
      commandId: "init-before-crash",
      command: {
        type: "initialize"
      }
    });
    lifecycleState = "error";
    await orchestrator.executeCommand({
      commandId: "init-after-crash",
      command: {
        type: "initialize"
      }
    });

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent adapter initialization", async () => {
    const initializeGate = createDeferred();
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn(async () => {
      await initializeGate.promise;
      lifecycleState = "ready";
    });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
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
    const domainService = new DomainService({
      now: () => "2026-04-20T00:02:00Z",
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
      engineId: "codex"
    });

    const first = orchestrator.executeCommand({
      commandId: "init-concurrent-1",
      command: {
        type: "initialize"
      }
    });
    const second = orchestrator.executeCommand({
      commandId: "init-concurrent-2",
      command: {
        type: "initialize"
      }
    });
    await flushAsyncWork();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();

    initializeGate.resolve();
    await Promise.all([first, second]);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("initializes switched engines independently and reinitializes only failed adapters", async () => {
    const codexUnsubscribe = vi.fn();
    const piUnsubscribe = vi.fn();
    let codexLifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    let piLifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const codexInitialize = vi.fn().mockImplementation(async () => {
      codexLifecycleState = "ready";
    });
    const piInitialize = vi.fn().mockImplementation(async () => {
      piLifecycleState = "ready";
    });
    const codexDispose = vi.fn().mockImplementation(async () => {
      codexLifecycleState = "stopped";
    });
    const piDispose = vi.fn().mockImplementation(async () => {
      piLifecycleState = "stopped";
    });
    const codexAdapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => codexLifecycleState,
      initialize: codexInitialize,
      executeCommand: vi.fn().mockResolvedValue({
        commandId: "codex-noop",
        commandType: "initialize",
        accepted: true
      }),
      subscribe: vi.fn().mockReturnValue(codexUnsubscribe),
      dispose: codexDispose
    };
    const piAdapter: AgentAdapter = {
      id: "pi-adapter",
      kind: "acp",
      getLifecycleState: () => piLifecycleState,
      initialize: piInitialize,
      executeCommand: vi.fn().mockResolvedValue({
        commandId: "pi-noop",
        commandType: "initialize",
        accepted: true
      }),
      subscribe: vi.fn().mockReturnValue(piUnsubscribe),
      dispose: piDispose
    };

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: () => "2026-04-20T00:02:00Z",
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
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat"]
          },
          adapter: codexAdapter
        },
        {
          descriptor: {
            engineId: "pi-acp",
            displayName: "Pi",
            capabilities: ["chat"]
          },
          adapter: piAdapter
        }
      ]
    });

    await orchestrator.executeCommand({
      commandId: "init-codex-1",
      command: {
        type: "initialize"
      }
    });
    orchestrator.selectEngine({
      engineId: "pi-acp",
      config: {
        profile: "fallback"
      }
    });
    await orchestrator.executeCommand({
      commandId: "init-pi-1",
      command: {
        type: "initialize"
      }
    });
    await orchestrator.executeCommand({
      commandId: "init-pi-2",
      command: {
        type: "initialize"
      }
    });

    expect(codexInitialize).toHaveBeenCalledTimes(1);
    expect(piInitialize).toHaveBeenCalledTimes(1);
    expect(piInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          selectedConfig: {
            profile: "fallback"
          }
        })
      })
    );
    expect(codexAdapter.subscribe).toHaveBeenCalledTimes(1);
    expect(piAdapter.subscribe).toHaveBeenCalledTimes(1);

    orchestrator.selectEngine({
      engineId: "codex"
    });
    codexLifecycleState = "error";
    await orchestrator.executeCommand({
      commandId: "init-codex-after-failure",
      command: {
        type: "initialize"
      }
    });

    expect(codexInitialize).toHaveBeenCalledTimes(2);
    expect(piInitialize).toHaveBeenCalledTimes(1);
    expect(codexAdapter.subscribe).toHaveBeenCalledTimes(1);

    await orchestrator.dispose();

    expect(codexUnsubscribe).toHaveBeenCalledTimes(1);
    expect(piUnsubscribe).toHaveBeenCalledTimes(1);
    expect(codexDispose).toHaveBeenCalledTimes(1);
    expect(piDispose).toHaveBeenCalledTimes(1);
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
      accepted: true,
      outcome: {
        type: "turn_started",
        sessionId: "session-title",
        turnId: "turn-title"
      }
    });
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const adapter: AgentAdapter = {
      id: "acp-adapter",
      kind: "acp",
      getLifecycleState: () => lifecycleState,
      initialize,
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
      accepted: true,
      outcome: {
        type: "turn_started",
        sessionId: "session-title",
        turnId: "turn-title"
      }
    });
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
      initialize,
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

  it("waits for pending title generation before disposing adapters", async () => {
    const syncSession = vi.fn().mockResolvedValue(undefined);
    const titleGate = createDeferred<string>();
    const generateTitle = vi.fn(() => titleGate.promise);
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: "send-1",
      commandType: "sendUserMessage",
      accepted: true,
      outcome: {
        type: "turn_started",
        sessionId: "session-title-drain",
        turnId: "turn-title-drain"
      }
    });
    const dispose = vi.fn().mockResolvedValue(undefined);
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
      initialize,
      executeCommand,
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose
    };

    let orchestrator: RuntimeOrchestrator | undefined;
    const domainService = new DomainService({
      now: () => "2026-04-20T00:04:00Z",
      createSessionId: () => "session-title-drain",
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
      createConversationId: () => "conversation-title-drain",
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
        content: "summarize the runtime lifecycle plan",
        attachments: []
      }
    });

    expect(generateTitle).toHaveBeenCalledTimes(1);
    const disposePromise = orchestrator.dispose();
    await flushAsyncWork();

    expect(dispose).not.toHaveBeenCalled();

    titleGate.resolve("Runtime lifecycle plan");
    await disposePromise;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(domainService.getSession(session.sessionId)?.title).toBe(
      "Runtime lifecycle plan"
    );
    expect(syncSession).toHaveBeenCalledWith("session-title-drain");
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
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
      initialize,
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
    let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
    const initialize = vi.fn().mockImplementation(async () => {
      lifecycleState = "ready";
    });
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => lifecycleState,
      initialize,
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

  it("commits one canonical turn across response ordering and isolates buffered publish failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshots = [];
    for (const ordering of ["event-first", "response-first"] as const) {
      const startGate = createDeferred<void>();
      let listener: Parameters<AgentAdapter["subscribe"]>[0] | undefined;
      let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
      const adapter: AgentAdapter = {
        id: `adapter-${ordering}`,
        kind: "codex",
        getLifecycleState: () => lifecycleState,
        initialize: async () => {
          lifecycleState = "ready";
        },
        executeCommand: async (envelope) => {
          if (envelope.command.type === "sendUserMessage" && ordering === "event-first") {
            listener?.({
              eventId: `event-${ordering}`,
              occurredAt: "2026-07-18T00:00:01Z",
              event: {
                type: "turn.started",
                sessionId: envelope.command.sessionId,
                turnId: "turn-canonical"
              }
            });
            await startGate.promise;
          }
          return {
            commandId: envelope.commandId,
            commandType: envelope.command.type,
            accepted: true,
            outcome:
              envelope.command.type === "sendUserMessage"
                ? {
                    type: "turn_started" as const,
                    sessionId: envelope.command.sessionId,
                    turnId: "turn-canonical"
                  }
                : { type: "command_accepted" as const }
          };
        },
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        dispose: async () => {}
      };
      let orchestrator: RuntimeOrchestrator | undefined;
      const domainService = new DomainService({
        now: () => "2026-07-18T00:00:00Z",
        createSessionId: () => "session-canonical",
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
          selectWorkspace: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" })
        } as never,
        publishRuntimeEvent: () => {
          if (ordering === "event-first") {
            throw new Error("subscriber failed after canonical start");
          }
        },
        createConversationId: () => "conversation-canonical",
        agentBindings: [{
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat"]
          },
          adapter
        }]
      });
      await orchestrator.createSession({ engineId: "codex", workspaceId: "workspace-1" });
      const sendEnvelope = {
        commandId: `send-${ordering}`,
        command: {
          type: "sendUserMessage",
          sessionId: "session-canonical",
          messageId: "message-canonical",
          content: "hello",
          attachments: []
        }
      } as const;
      const receipt =
        ordering === "event-first"
          ? await (async () => {
              const firstSend = orchestrator.executeCommand(sendEnvelope);
              await flushAsyncWork();
              await expect(orchestrator.executeCommand({
                ...sendEnvelope,
                commandId: "send-conflict"
              })).resolves.toMatchObject({ accepted: false });
              startGate.resolve();
              return firstSend;
            })()
          : await orchestrator.executeCommand(sendEnvelope);
      if (ordering === "response-first") {
        listener?.({
          eventId: `event-${ordering}`,
          occurredAt: "2026-07-18T00:00:01Z",
          event: {
            type: "turn.started",
            sessionId: "session-canonical",
            turnId: "turn-canonical"
          }
        });
      }
      expect(receipt).toMatchObject({
        accepted: true,
        sessionId: "session-canonical",
        turnId: "turn-canonical"
      });
      const snapshot = domainService.getSnapshot();
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]).toMatchObject({
        turnId: "turn-canonical",
        messageIds: ["message-canonical"]
      });
      expect(snapshot.turns.some((turn) => turn.turnId.startsWith("user-turn-"))).toBe(false);
      snapshots.push(snapshot.turns[0]);
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(warn).toHaveBeenCalledWith(
      "[another-workbench] Failed to ingest adapter event",
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it("rejects mismatched canonical events and restores idle after adapter failure", async () => {
    const createHarness = (executeCommand: AgentAdapter["executeCommand"]) => {
      let listener: Parameters<AgentAdapter["subscribe"]>[0] | undefined;
      let lifecycleState: ReturnType<AgentAdapter["getLifecycleState"]> = "idle";
      const adapter: AgentAdapter = {
        id: "adapter-send-protocol",
        kind: "codex",
        getLifecycleState: () => lifecycleState,
        initialize: async () => {
          lifecycleState = "ready";
        },
        executeCommand,
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        dispose: async () => {}
      };
      let orchestrator: RuntimeOrchestrator | undefined;
      const domainService = new DomainService({
        now: () => "2026-07-18T00:00:00Z",
        createSessionId: () => "session-send-protocol",
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
          selectWorkspace: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" })
        } as never,
        publishRuntimeEvent: () => {},
        createConversationId: () => "conversation-send-protocol",
        agentBindings: [{
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat"]
          },
          adapter
        }]
      });
      return { domainService, getListener: () => listener, orchestrator };
    };

    const mismatchHarness = createHarness(async (envelope) => {
      mismatchHarness.getListener()?.({
        eventId: "event-mismatched-turn",
        occurredAt: "2026-07-18T00:00:01Z",
        event: {
          type: "turn.started",
          sessionId: "session-send-protocol",
          turnId: "turn-event"
        }
      });
      return {
        commandId: envelope.commandId,
        commandType: envelope.command.type,
        accepted: true,
        outcome: {
          type: "turn_started" as const,
          sessionId: "session-send-protocol",
          turnId: "turn-receipt"
        }
      };
    });
    await mismatchHarness.orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1"
    });
    await expect(mismatchHarness.orchestrator.executeCommand({
      commandId: "send-mismatched-turn",
      command: {
        type: "sendUserMessage",
        sessionId: "session-send-protocol",
        messageId: "message-mismatched-turn",
        content: "hello",
        attachments: []
      }
    })).resolves.toMatchObject({ accepted: false });
    expect(mismatchHarness.domainService.getSnapshot().turns).toEqual([]);
    expect(mismatchHarness.domainService.getSession("session-send-protocol")?.status).toBe("idle");

    const failureHarness = createHarness(async () => {
      throw new Error("adapter failed");
    });
    await failureHarness.orchestrator.createSession({
      engineId: "codex",
      workspaceId: "workspace-1"
    });
    await expect(failureHarness.orchestrator.executeCommand({
      commandId: "send-adapter-failure",
      command: {
        type: "sendUserMessage",
        sessionId: "session-send-protocol",
        messageId: "message-adapter-failure",
        content: "hello",
        attachments: []
      }
    })).rejects.toThrow("adapter failed");
    expect(failureHarness.domainService.getSession("session-send-protocol")?.status).toBe("idle");
  });

});
