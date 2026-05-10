import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "@another-workbench/adapters";
import type { EventEnvelope } from "@another-workbench/shared";
import { createCodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import { HostToolRegistry } from "../src/host-tools.js";
import { SessionIndexStore } from "../src/session-index.js";
import { SmartTakeoverService } from "../src/smart-takeover-service.js";
import { takeoverVerdictToolName } from "../src/smart-takeover-tool.js";
import { TakeoverPresetStore } from "../src/takeover-preset-store.js";
import { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)
);

const tempDirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-smart-takeover-"));
  tempDirs.push(dir);
  return dir;
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> => {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createManualTakeoverHarness = async () => {
  const baseDir = await createTempDir();
  const presetStore = new TakeoverPresetStore({ baseDir });
  const sessions = new Map<string, Record<string, unknown>>();
  const commands: Array<Record<string, unknown>> = [];
  const subscribers = new Set<(envelope: EventEnvelope) => void>();
  let childIndex = 0;
  let idIndex = 0;
  let cursorIndex = 0;
  sessions.set("session-parent", {
    sessionId: "session-parent",
    conversationId: "conversation-manual",
    engineId: "codex",
    status: "idle",
    createdAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
    metadata: {
      cwd: "I:/workspace"
    }
  });

  const runtimeService = {
    getSession: (sessionId: string) => sessions.get(sessionId),
    getSnapshot: () => ({
      conversations: [
        {
          conversationId: "conversation-manual",
          workspaceId: "workspace-manual",
          participantEngineIds: ["codex"],
          sessionIds: [...sessions.keys()],
          createdAt: "2026-05-10T00:00:00Z",
          updatedAt: "2026-05-10T00:00:00Z"
        }
      ],
      sessions: [...sessions.values()],
      turns: [],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      participants: [],
      sessionRelations: []
    }),
    getSnapshotResult: () => ({
      snapshot: runtimeService.getSnapshot(),
      cursor: `cursor-${++cursorIndex}`
    }),
    getWorkspaceRegistry: () => undefined,
    resolveProviderSessionHandle: (sessionId: string) => ({
      providerKind: "codex-thread",
      providerSessionId: `thread-${sessionId}`
    }),
    createRelatedSession: async (input: {
      metadata?: Record<string, unknown>;
      parentSessionId: string;
      engineId: string;
    }) => {
      const sessionId = `session-takeover-${++childIndex}`;
      const session = {
        sessionId,
        conversationId: "conversation-manual",
        engineId: input.engineId,
        status: "idle",
        createdAt: "2026-05-10T00:00:00Z",
        updatedAt: "2026-05-10T00:00:00Z",
        metadata: input.metadata
      };
      sessions.set(sessionId, session);
      return session;
    },
    executeCommand: async (input: {
      commandId?: string;
      command: Record<string, unknown> & { type: string };
    }) => {
      commands.push(input.command);
      return {
        commandId: input.commandId ?? `cmd-${commands.length}`,
        commandType: input.command.type,
        accepted: true
      };
    },
    subscribeFromCursor: (handler: (envelope: EventEnvelope) => void) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    }
  } as never;

  const service = new SmartTakeoverService({
    runtimeService,
    presetStore,
    defaultTimeoutMs: 1_000,
    createId: () => `manual-${++idIndex}`
  });

  const submitVerdict = async (
    takeoverSessionId: string,
    verdict: "complete" | "incomplete",
    response: string
  ) => {
    const verdictTool = service
      .createHostTools()
      .find((tool) => tool.name === takeoverVerdictToolName);
    return verdictTool?.handle({
      definition: verdictTool,
      arguments: {
        verdict,
        response
      },
      context: {
        engineId: "codex",
        sessionId: takeoverSessionId,
        providerSessionId: `thread-${takeoverSessionId}`
      }
    } as never);
  };

  return {
    service,
    commands,
    sessions,
    submitVerdict,
    emit: (envelope: EventEnvelope) => {
      for (const subscriber of subscribers) {
        subscriber(envelope);
      }
    }
  };
};

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    if (dispose) {
      await dispose();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SmartTakeoverService", () => {
  it("recognizes hydrated takeover sessions from session metadata", async () => {
    const baseDir = await createTempDir();
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: (sessionId: string) =>
          sessionId === "session-hydrated"
            ? {
                metadata: {
                  takeover: {
                    role: "takeover-agent",
                    runId: "run-hydrated"
                  }
                }
              }
            : undefined
      } as never,
      presetStore: new TakeoverPresetStore({ baseDir })
    });

    expect(service.isTakeoverSession("session-hydrated")).toBe(true);
    expect(service.isActiveTakeoverRun("session-hydrated")).toBe(false);
    expect(service.isTakeoverSession("session-regular")).toBe(false);
  });

  it("settles the run that belongs to the calling takeover session", async () => {
    const baseDir = await createTempDir();
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined
      } as never,
      presetStore: new TakeoverPresetStore({ baseDir })
    });
    const internals = service as unknown as {
      runsById: Map<string, { takeoverSessionId: string }>;
      runIdByTakeoverSessionId: Map<string, string>;
      pendingVerdictResolvers: Map<string, () => void>;
    };
    let runAResolved = false;
    let runBResolved = false;
    internals.runsById.set("run-a", { takeoverSessionId: "session-a" });
    internals.runsById.set("run-b", { takeoverSessionId: "session-b" });
    internals.runIdByTakeoverSessionId.set("session-a", "run-a");
    internals.runIdByTakeoverSessionId.set("session-b", "run-b");
    internals.pendingVerdictResolvers.set("run-a", () => {
      runAResolved = true;
    });
    internals.pendingVerdictResolvers.set("run-b", () => {
      runBResolved = true;
    });

    const verdictTool = service
      .createHostTools()
      .find((tool) => tool.name === takeoverVerdictToolName);

    const result = await verdictTool?.handle({
      definition: verdictTool,
      arguments: {
        verdict: "complete",
        response: "Complete from the calling takeover session."
      },
      context: {
        engineId: "codex",
        sessionId: "session-a",
        providerSessionId: "thread-a"
      }
    } as never);

    expect(result).toMatchObject({ success: true });
    expect(runAResolved).toBe(true);
    expect(runBResolved).toBe(false);
    expect(internals.runsById.has("run-a")).toBe(true);
  });

  it("rejects invalid, duplicate, and orphaned verdict submissions", async () => {
    const baseDir = await createTempDir();
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined
      } as never,
      presetStore: new TakeoverPresetStore({ baseDir })
    });
    const internals = service as unknown as {
      runsById: Map<string, { takeoverSessionId: string }>;
      runIdByTakeoverSessionId: Map<string, string>;
      pendingVerdictResolvers: Map<string, () => void>;
    };
    internals.runsById.set("run-a", { takeoverSessionId: "session-a" });
    internals.runIdByTakeoverSessionId.set("session-a", "run-a");
    internals.pendingVerdictResolvers.set("run-a", () => {
      internals.pendingVerdictResolvers.delete("run-a");
      internals.runIdByTakeoverSessionId.delete("session-a");
      internals.runsById.delete("run-a");
    });

    const verdictTool = service
      .createHostTools()
      .find((tool) => tool.name === takeoverVerdictToolName);
    const invoke = (argumentsValue: Record<string, unknown>, sessionId = "session-a") =>
      verdictTool?.handle({
        definition: verdictTool,
        arguments: argumentsValue,
        context: {
          engineId: "codex",
          sessionId,
          providerSessionId: `thread-${sessionId}`
        }
      } as never);

    await expect(
      invoke({
        verdict: "changes_requested",
        response: "old enum"
      })
    ).resolves.toMatchObject({ success: false });
    await expect(
      invoke({
        verdict: "incomplete"
      })
    ).resolves.toMatchObject({ success: false });
    await expect(
      invoke(
        {
          verdict: "complete",
          response: "wrong session"
        },
        "session-b"
      )
    ).resolves.toMatchObject({ success: false });
    await expect(
      invoke({
        takeoverRunId: "run-b",
        verdict: "incomplete",
        response: "old run id should be ignored"
      })
    ).resolves.toMatchObject({ success: true });
    await expect(
      invoke({
        verdict: "complete",
        response: "duplicate"
      })
    ).resolves.toMatchObject({ success: false });
  });

  it("keeps waiting for a takeover verdict after recoverable runtime errors", async () => {
    const baseDir = await createTempDir();
    let onEnvelope: ((envelope: EventEnvelope) => void) | undefined;
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined,
        subscribeFromCursor: (handler: (envelope: EventEnvelope) => void) => {
          onEnvelope = handler;
          return () => undefined;
        }
      } as never,
      presetStore: new TakeoverPresetStore({ baseDir })
    });
    const internals = service as unknown as {
      waitForVerdict: (input: {
        runId: string;
        takeoverSessionId: string;
        timeoutMs: number;
      }) => Promise<{ verdict: "complete" | "incomplete"; response: string }>;
    };

    const verdict = internals.waitForVerdict({
      runId: "run-1",
      takeoverSessionId: "session-takeover",
      timeoutMs: 1_000
    });
    await waitFor(() => Boolean(onEnvelope));

    onEnvelope?.({
      eventId: "event-recoverable",
      cursor: "cursor-recoverable",
      occurredAt: "2026-05-10T00:00:00Z",
      event: {
        type: "runtime.error",
        sessionId: "session-takeover",
        message: "Reconnecting... 1/5",
        recoverable: true
      }
    } as EventEnvelope);
    onEnvelope?.({
      eventId: "event-message",
      cursor: "cursor-message",
      occurredAt: "2026-05-10T00:00:01Z",
      event: {
        type: "message.completed",
        sessionId: "session-takeover",
        turnId: "turn-1",
        messageId: "message-1",
        finalText: "Looks good.\nTAKEOVER_VERDICT: complete"
      }
    } as EventEnvelope);
    onEnvelope?.({
      eventId: "event-turn",
      cursor: "cursor-turn",
      occurredAt: "2026-05-10T00:00:02Z",
      event: {
        type: "turn.completed",
        sessionId: "session-takeover",
        turnId: "turn-1",
        finishReason: "completed"
      }
    } as EventEnvelope);

    await expect(verdict).resolves.toMatchObject({
      verdict: "complete",
      response: expect.stringContaining("Looks good.")
    });
  });

  it("enables manual takeover without starting the takeover agent until the parent turn completes", async () => {
    const harness = await createManualTakeoverHarness();
    const parent = harness.sessions.get("session-parent");
    if (parent) {
      parent.status = "running";
    }

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });

    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "managed",
      active: false,
      manualPresetId: "review",
      presetId: "review"
    });
    expect(harness.sessions.has("session-takeover-1")).toBe(false);
    expect(harness.commands).toEqual([]);

    if (parent) {
      parent.status = "idle";
    }
    harness.emit({
      eventId: "event-parent-completed",
      cursor: "cursor-parent-completed",
      occurredAt: "2026-05-10T00:00:00Z",
      event: {
        type: "turn.completed",
        sessionId: "session-parent",
        turnId: "turn-parent",
        finishReason: "completed"
      }
    } as EventEnvelope);

    await waitFor(() => harness.service.getSessionState("session-parent").active);
    expect(harness.sessions.has("session-takeover-1")).toBe(true);
    expect(harness.commands).toEqual([
      expect.objectContaining({
        type: "sendUserMessage",
        sessionId: "session-takeover-1"
      })
    ]);
  });

  it("does not send the takeover prompt when disabled during launch", async () => {
    const baseDir = await createTempDir();
    const presetStore = new TakeoverPresetStore({ baseDir });
    let resolveRelatedSession:
      | ((session: {
          sessionId: string;
          conversationId: string;
          engineId: string;
          status: string;
          createdAt: string;
          updatedAt: string;
          metadata?: Record<string, unknown>;
        }) => void)
      | undefined;
    const commands: Array<Record<string, unknown>> = [];
    const runtimeService = {
      getSession: (sessionId: string) =>
        sessionId === "session-parent"
          ? {
              sessionId: "session-parent",
              conversationId: "conversation-1",
              engineId: "codex",
              status: "idle",
              createdAt: "2026-05-10T00:00:00Z",
              updatedAt: "2026-05-10T00:00:00Z",
              metadata: {
                cwd: "I:/workspace"
              }
            }
          : undefined,
      getSnapshot: () => ({
        conversations: [
          {
            conversationId: "conversation-1",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            sessionIds: ["session-parent"],
            createdAt: "2026-05-10T00:00:00Z",
            updatedAt: "2026-05-10T00:00:00Z"
          }
        ],
        sessions: [],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      }),
      getSnapshotResult: () => ({
        snapshot: runtimeService.getSnapshot(),
        cursor: "cursor-1"
      }),
      getWorkspaceRegistry: () => undefined,
      resolveProviderSessionHandle: () => undefined,
      createRelatedSession: (input: { metadata?: Record<string, unknown> }) =>
        new Promise((resolve) => {
          resolveRelatedSession = resolve;
        }).then((session) => ({
          ...session,
          metadata: input.metadata
        })),
      executeCommand: async (input: { command: Record<string, unknown> }) => {
        commands.push(input.command);
        return {
          commandId: "cmd",
          commandType: input.command.type,
          accepted: true
        };
      },
      subscribeFromCursor: () => () => undefined
    } as never;
    const service = new SmartTakeoverService({
      runtimeService,
      presetStore,
      defaultTimeoutMs: 1_000
    });

    await service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => Boolean(resolveRelatedSession));
    await service.setManualTakeover({
      sessionId: "session-parent"
    });

    resolveRelatedSession?.({
      sessionId: "session-takeover",
      conversationId: "conversation-1",
      engineId: "codex",
      status: "idle",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands).toEqual([]);
    expect(service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });
  });

  it("returns an already enabled message when SmartTakeover is called again", async () => {
    const harness = await createManualTakeoverHarness();
    const parent = harness.sessions.get("session-parent");
    if (parent) {
      parent.status = "running";
    }
    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    const smartTakeoverTool = harness.service
      .createHostTools()
      .find((tool) => tool.name === "SmartTakeover");

    const result = await smartTakeoverTool?.handle({
      definition: smartTakeoverTool,
      arguments: {
        action: "start",
        presetId: "review"
      },
      context: {
        engineId: "codex",
        sessionId: "session-parent",
        providerSessionId: "thread-session-parent"
      }
    } as never);

    expect(result).toMatchObject({
      success: true,
      contentItems: [
        expect.objectContaining({
          text: expect.stringContaining("SmartTakeover is already enabled")
        })
      ]
    });
  });

  it("clears manual takeover after a complete verdict", async () => {
    const harness = await createManualTakeoverHarness();

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const activeState = harness.service.getSessionState("session-parent");
    expect(activeState).toMatchObject({
      role: "managed",
      manualPresetId: "review",
      presetId: "review"
    });

    await harness.submitVerdict(
      activeState.takeoverSessionId!,
      "complete",
      "Manual review complete."
    );

    await waitFor(() => harness.service.getSessionState("session-parent").role === "none");
    expect(harness.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "sendUserMessage",
          sessionId: "session-parent",
          content: "Manual review complete."
        })
      ])
    );
  });

  it("cancels manual takeover when disabled", async () => {
    const harness = await createManualTakeoverHarness();

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);

    const state = await harness.service.setManualTakeover({
      sessionId: "session-parent"
    });

    expect(state).toMatchObject({
      role: "none",
      active: false
    });
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });
  });

  it("restarts manual takeover when the selected preset changes", async () => {
    const harness = await createManualTakeoverHarness();

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const firstState = harness.service.getSessionState("session-parent");

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "progress"
    });
    await waitFor(() => {
      const state = harness.service.getSessionState("session-parent");
      return (
        state.active &&
        state.presetId === "progress" &&
        state.takeoverSessionId !== firstState.takeoverSessionId
      );
    });

    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "managed",
      active: true,
      manualPresetId: "progress",
      presetId: "progress"
    });
  });

  it("enables takeover from the parent tool call and forwards the submitted verdict after parent completion", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: () => "workspace-1"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "D:/workspace/another-workbench"
    });
    const sessionIndexStore = new SessionIndexStore({ baseDir });
    const presetStore = new TakeoverPresetStore({ baseDir });
    const hostTools = new HostToolRegistry();

    let runtimeService: WorkbenchRuntimeService | undefined;
    const codexRuntimePort = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: (sessionId) =>
        runtimeService?.resolveConversationIdForSession(sessionId),
      hostTools
    });
    disposers.push(() => codexRuntimePort.stop());

    const codexAdapter = createCodexAdapter(codexRuntimePort, {
      id: "codex",
      fallbackAgentId: "codex",
      resolveConversationIdBySessionId: (sessionId) =>
        runtimeService?.resolveConversationIdForSession(sessionId)
    });

    runtimeService = new WorkbenchRuntimeService({
      now: (() => {
        let tick = 0;
        return () => `2026-05-10T00:00:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createConversationId: () => "conversation-1",
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
      workspaceRegistry,
      sessionIndexStore,
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "tool"]
          },
          integrationTier: "native",
          transportKind: "codex",
          providerKind: "codex-thread",
          adapter: codexAdapter,
          resolveProviderSessionId: (sessionId) =>
            codexRuntimePort.getThreadIdForSession(sessionId)
        }
      ]
    });
    disposers.push(() => runtimeService?.dispose() ?? Promise.resolve());

    const smartTakeoverService = new SmartTakeoverService({
      runtimeService,
      presetStore,
      defaultTimeoutMs: 3_000,
      createId: (() => {
        let index = 0;
        return () => `takeover-${++index}`;
      })()
    });
    for (const tool of smartTakeoverService.createHostTools()) {
      hostTools.register(tool);
    }

    const events: EventEnvelope[] = [];
    const unsubscribe = runtimeService.subscribe((event) => {
      events.push(event);
    });
    disposers.push(async () => unsubscribe());

    await runtimeService.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });

    await runtimeService.executeCommand({
      commandId: "cmd-parent",
      command: {
        type: "sendUserMessage",
        sessionId: "session-1",
        messageId: "message-parent",
        content: "please trigger smart-takeover-start",
        attachments: [],
        cwd: "D:/workspace/another-workbench"
      }
    });

    await waitFor(() =>
      runtimeService.listSessions().some((session) => session.sessionId === "session-2")
    );
    await waitFor(() =>
      events.some(
        (event) =>
          event.event.type === "message.completed" &&
          event.event.sessionId === "session-1" &&
          "finalText" in event.event &&
          event.event.finalText?.includes("Fake reviewer completed the takeover flow")
      )
    );

    expect(runtimeService.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-1" }),
        expect.objectContaining({
          sessionId: "session-2",
          metadata: expect.objectContaining({
            takeover: expect.objectContaining({
              parentSessionId: "session-1",
              presetId: "review",
              role: "takeover-agent"
            })
          })
        })
      ])
    );
    expect(sessionIndexStore.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "session-1",
        childSessionId: "session-2",
        relationType: "subagent"
      })
    ]);
    const serviceInternals = smartTakeoverService as unknown as {
      runsById: Map<string, unknown>;
      runIdByTakeoverSessionId: Map<string, string>;
      pendingVerdictResolvers: Map<string, unknown>;
    };
    expect(serviceInternals.runsById.size).toBe(0);
    expect(serviceInternals.runIdByTakeoverSessionId.size).toBe(0);
    expect(serviceInternals.pendingVerdictResolvers.size).toBe(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool.completed",
            sessionId: "session-1",
            outputSummary: expect.stringContaining("SmartTakeover enabled")
          })
        })
      ])
    );
  });
});
