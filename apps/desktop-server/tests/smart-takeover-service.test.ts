import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const createManualTakeoverHarness = async (options: {
  resolveCurrentBranchContext?: (
    sessionId: string
  ) =>
    | { currentTurnId?: string; visibleTurnIds?: string[] }
    | undefined
    | Promise<{ currentTurnId?: string; visibleTurnIds?: string[] } | undefined>;
  executeCommand?: (input: {
    commandId?: string;
    command: Record<string, unknown> & { type: string };
  }) => Promise<{ commandId: string; commandType: string; accepted: boolean }>;
  resolveProviderSessionHandle?: (
    sessionId: string
  ) => { providerKind: string; providerSessionId: string } | undefined;
  defaultTimeoutMs?: number;
  threadGoals?: Array<Record<string, unknown>>;
} = {}) => {
  const baseDir = await createTempDir();
  const presetStore = new TakeoverPresetStore({ baseDir });
  const sessions = new Map<string, Record<string, unknown>>();
  const commands: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const messageBlocks: Array<Record<string, unknown>> = [];
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
      turns,
      messageBlocks,
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      participants: [],
      sessionRelations: [],
      threadGoals: options.threadGoals ?? []
    }),
    getSnapshotResult: () => ({
      snapshot: runtimeService.getSnapshot(),
      cursor: `cursor-${++cursorIndex}`
    }),
    getWorkspaceRegistry: () => undefined,
    resolveProviderSessionHandle:
      options.resolveProviderSessionHandle ??
      ((sessionId: string) => ({
        providerKind: "codex-thread",
        providerSessionId: `thread-${sessionId}`
      })),
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
      if (options.executeCommand) {
        return options.executeCommand(input);
      }
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
    defaultTimeoutMs: options.defaultTimeoutMs ?? 1_000,
    createId: () => `manual-${++idIndex}`,
    resolveCurrentBranchContext: options.resolveCurrentBranchContext
  });

  const submitVerdict = async (
    takeoverSessionId: string,
    verdict: "complete" | "incomplete",
    response: string,
    sourceTurnId?: string
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
        providerSessionId: `thread-${takeoverSessionId}`,
        providerTurnId: sourceTurnId
      }
    } as never);
  };

  return {
    service,
    presetStore,
    commands,
    turns,
    messageBlocks,
    sessions,
    submitVerdict,
    subscriberCount: () => subscribers.size,
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
  it("lists available preset ids and descriptions in the SmartTakeover schema", async () => {
    const baseDir = await createTempDir();
    const presetStore = new TakeoverPresetStore({ baseDir });
    await presetStore.upsert({
      presetId: "team_review",
      prompt: "desc: Team-specific reviewer\n\n# Team Review"
    });
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined
      } as never,
      presetStore
    });
    const hostTools = new HostToolRegistry(service.createHostTools());

    const definitions = await hostTools.listDefinitions({
      engineId: "codex",
      sessionId: "session-parent"
    });
    const smartTakeover = definitions.find((tool) => tool.name === "SmartTakeover");
    const schema = smartTakeover?.inputSchema as {
      properties?: {
        presetId?: {
          description?: string;
        };
        context?: {
          description?: string;
        };
      };
    };
    const presetIdDescription = schema.properties?.presetId?.description ?? "";
    const contextDescription = schema.properties?.context?.description ?? "";

    expect(smartTakeover?.inputSchema).not.toHaveProperty("required");
    expect(schema.properties).not.toHaveProperty("helpTopic");
    expect(smartTakeover?.description).toContain(
      "Before starting takeover"
    );
    expect(smartTakeover?.description).toContain(
      "action=\"help\""
    );
    expect(smartTakeover?.description).toContain(
      "mutually exclusive with Codex goals"
    );
    expect(presetIdDescription).toContain("Available presets:");
    expect(presetIdDescription).toContain("Required when action is start");
    expect(presetIdDescription).toContain("not needed for help or stop");
    expect(presetIdDescription).toContain(
      "- progress: Delegated reviewer for checking the development progress"
    );
    expect(presetIdDescription).toContain("- review: Delegated reviewer");
    expect(presetIdDescription).toContain("- team_review: Team-specific reviewer");
    expect(contextDescription).toContain("Before starting takeover");
    expect(contextDescription).toContain("action=\"help\"");
  });

  it("reloads SmartTakeover description and complete help from the user directory", async () => {
    const baseDir = await createTempDir();
    const presetStore = new TakeoverPresetStore({ baseDir });
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined
      } as never,
      presetStore
    });
    const hostTools = new HostToolRegistry(service.createHostTools());

    await hostTools.listDefinitions({
      engineId: "codex",
      sessionId: "session-parent"
    });
    await writeFile(
      join(presetStore.getSystemResourcePath(), "description.md"),
      "User-edited SmartTakeover description",
      "utf8"
    );
    await writeFile(
      join(presetStore.getSystemResourcePath(), "help.md"),
      "User-edited complete help\n\nRoot: {{presetRoot}}\nSystem: {{systemRoot}}\n\n{{presetList}}",
      "utf8"
    );

    const definitions = await hostTools.listDefinitions({
      engineId: "codex",
      sessionId: "session-parent"
    });
    expect(
      definitions.find((tool) => tool.name === "SmartTakeover")?.description
    ).toBe("User-edited SmartTakeover description");

    const smartTakeoverTool = service
      .createHostTools()
      .find((tool) => tool.name === "SmartTakeover");
    const result = await smartTakeoverTool?.handle({
      definition: smartTakeoverTool,
      arguments: {
        action: "help"
      },
      context: {
        engineId: "codex",
        sessionId: "session-parent",
        providerSessionId: "thread-session-parent"
      }
    } as never);
    const text = result?.contentItems[0]?.type === "inputText"
      ? result.contentItems[0].text
      : "";
    expect(text).toContain("User-edited complete help");
    expect(text).toContain(`Root: ${join(baseDir, "takeover")}`);
    expect(text).toContain(
      `System: ${join(baseDir, "takeover", "_system")}`
    );
    expect(text).toContain("- review: Delegated reviewer");
    expect(text).not.toContain("{{presetRoot}}");
    expect(text).not.toContain("{{systemRoot}}");
    expect(text).not.toContain("{{presetList}}");
  });

  it("includes SmartTakeover context examples in help", async () => {
    const baseDir = await createTempDir();
    const presetStore = new TakeoverPresetStore({ baseDir });
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined
      } as never,
      presetStore
    });
    const smartTakeoverTool = service
      .createHostTools()
      .find((tool) => tool.name === "SmartTakeover");

    const result = await smartTakeoverTool?.handle({
      definition: smartTakeoverTool,
      arguments: {
        action: "help"
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
          text: expect.stringContaining("Context purpose:")
        })
      ]
    });
    const text = result?.contentItems[0]?.type === "inputText"
      ? result.contentItems[0].text
      : "";
    expect(text).toContain("Bad context example:");
    expect(text).toContain("Good context example:");
    expect(text).toContain("Context must include only lifecycle-stable information");
    expect(text).toContain("Current phase, current task, active milestone");
    expect(text).toContain("This is bad because");
    expect(text).toContain("Project:\nI:\\GameDev\\Projects\\Experiment\\AGame");
    expect(text).toContain("ROADMAP.md defines task order");
    expect(text).toContain("This is good because");
    expect(text).toContain("It does not include the current phase");
    expect(text).toContain("Available presets:");
    expect(text).toContain("For review loops");
    expect(text).toContain("The takeover agent must call SubmitTakeoverVerdict once");
  });

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
      pendingVerdictResolvers: Map<string, (verdict: {
        complete?: (result: { success: boolean }) => void;
      }) => void>;
    };
    let runAResolved = false;
    let runBResolved = false;
    internals.runsById.set("run-a", { takeoverSessionId: "session-a" });
    internals.runsById.set("run-b", { takeoverSessionId: "session-b" });
    internals.runIdByTakeoverSessionId.set("session-a", "run-a");
    internals.runIdByTakeoverSessionId.set("session-b", "run-b");
    internals.pendingVerdictResolvers.set("run-a", (verdict) => {
      runAResolved = true;
      verdict.complete?.({ success: true });
    });
    internals.pendingVerdictResolvers.set("run-b", (verdict) => {
      runBResolved = true;
      verdict.complete?.({ success: true });
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
      pendingVerdictResolvers: Map<string, (verdict: {
        complete?: (result: { success: boolean }) => void;
      }) => void>;
    };
    internals.runsById.set("run-a", { takeoverSessionId: "session-a" });
    internals.runIdByTakeoverSessionId.set("session-a", "run-a");
    internals.pendingVerdictResolvers.set("run-a", (verdict) => {
      internals.pendingVerdictResolvers.delete("run-a");
      internals.runIdByTakeoverSessionId.delete("session-a");
      internals.runsById.delete("run-a");
      verdict.complete?.({ success: true });
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
      }) => Promise<{ verdict: "complete" | "incomplete"; response: string }>;
    };

    const verdict = internals.waitForVerdict({
      runId: "run-1",
      takeoverSessionId: "session-takeover"
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
      presetId: "review",
      context: "Focus on takeover context propagation."
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
    harness.turns.push({
      turnId: "turn-parent",
      sessionId: "session-parent",
      status: "completed",
      startedAt: "2026-05-10T00:00:00Z",
      completedAt: "2026-05-10T00:00:01Z",
      finalMessageId: "message-parent-final",
      messageIds: ["message-parent-final"]
    });
    harness.messageBlocks.push({
      blockId: "message-parent-final:md",
      messageId: "message-parent-final",
      sessionId: "session-parent",
      turnId: "turn-parent",
      role: "assistant",
      phase: "final_answer",
      kind: "markdown",
      text: "I finished the takeover prompt cleanup and updated the tests.",
      startedAt: "2026-05-10T00:00:00Z",
      completedAt: "2026-05-10T00:00:01Z"
    });
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
    expect(harness.commands[0]?.content).toContain("Agent output:");
    expect(harness.commands[0]?.content).toContain(
      "I finished the takeover prompt cleanup and updated the tests."
    );
    expect(harness.commands[0]?.content).toContain("Task context:");
    expect(harness.commands[0]?.content).toContain(
      "Focus on takeover context propagation."
    );
    expect(harness.commands[0]?.content).not.toContain(
      "Delegated reviewer for checking the reasonableness"
    );
    expect(harness.commands[0]?.content).not.toContain("parent agent");
  });

  it("uses the current chat tree turn output instead of the latest session output", async () => {
    const harness = await createManualTakeoverHarness({
      resolveCurrentBranchContext: () => ({
        currentTurnId: "turn-selected",
        visibleTurnIds: ["turn-selected"]
      })
    });
    harness.turns.push(
      {
        turnId: "turn-selected",
        sessionId: "session-parent",
        status: "completed",
        startedAt: "2026-05-10T00:00:00Z",
        completedAt: "2026-05-10T00:00:01Z",
        finalMessageId: "message-selected-final",
        messageIds: ["message-selected-final"]
      },
      {
        turnId: "turn-latest",
        sessionId: "session-parent",
        status: "completed",
        startedAt: "2026-05-10T00:01:00Z",
        completedAt: "2026-05-10T00:01:01Z",
        finalMessageId: "message-latest-final",
        messageIds: ["message-latest-final"]
      }
    );
    harness.messageBlocks.push(
      {
        blockId: "message-selected-final:md",
        messageId: "message-selected-final",
        sessionId: "session-parent",
        turnId: "turn-selected",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Selected chat tree node output.",
        startedAt: "2026-05-10T00:00:00Z",
        completedAt: "2026-05-10T00:00:01Z"
      },
      {
        blockId: "message-latest-final:md",
        messageId: "message-latest-final",
        sessionId: "session-parent",
        turnId: "turn-latest",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Chronologically latest branch output.",
        startedAt: "2026-05-10T00:01:00Z",
        completedAt: "2026-05-10T00:01:01Z"
      }
    );

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);

    const initialPrompt = String(harness.commands[0]?.content ?? "");
    expect(initialPrompt).toContain("Agent output:");
    expect(initialPrompt).toContain("Selected chat tree node output.");
    expect(initialPrompt).not.toContain("Chronologically latest branch output.");
  });

  it("falls back only within the current branch when the current chat tree turn is incomplete", async () => {
    const harness = await createManualTakeoverHarness({
      resolveCurrentBranchContext: () => ({
        currentTurnId: "turn-streaming",
        visibleTurnIds: ["turn-previous", "turn-streaming"]
      })
    });
    harness.turns.push(
      {
        turnId: "turn-previous",
        sessionId: "session-parent",
        status: "completed",
        startedAt: "2026-05-10T00:00:00Z",
        completedAt: "2026-05-10T00:00:01Z",
        finalMessageId: "message-previous-final",
        messageIds: ["message-previous-final"]
      },
      {
        turnId: "turn-streaming",
        sessionId: "session-parent",
        status: "running",
        startedAt: "2026-05-10T00:01:00Z",
        finalMessageId: "message-streaming-final",
        messageIds: ["message-streaming-final"]
      },
      {
        turnId: "turn-hidden-latest",
        sessionId: "session-parent",
        status: "completed",
        startedAt: "2026-05-10T00:02:00Z",
        completedAt: "2026-05-10T00:02:01Z",
        finalMessageId: "message-hidden-final",
        messageIds: ["message-hidden-final"]
      }
    );
    harness.messageBlocks.push(
      {
        blockId: "message-previous-final:md",
        messageId: "message-previous-final",
        sessionId: "session-parent",
        turnId: "turn-previous",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Previous visible branch output.",
        startedAt: "2026-05-10T00:00:00Z",
        completedAt: "2026-05-10T00:00:01Z"
      },
      {
        blockId: "message-streaming-final:md",
        messageId: "message-streaming-final",
        sessionId: "session-parent",
        turnId: "turn-streaming",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Partial streaming branch output.",
        startedAt: "2026-05-10T00:01:00Z"
      },
      {
        blockId: "message-hidden-final:md",
        messageId: "message-hidden-final",
        sessionId: "session-parent",
        turnId: "turn-hidden-latest",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Hidden latest sibling branch output.",
        startedAt: "2026-05-10T00:02:00Z",
        completedAt: "2026-05-10T00:02:01Z"
      }
    );

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);

    const initialPrompt = String(harness.commands[0]?.content ?? "");
    expect(initialPrompt).toContain("Agent output:");
    expect(initialPrompt).toContain("Previous visible branch output.");
    expect(initialPrompt).not.toContain("Partial streaming branch output.");
    expect(initialPrompt).not.toContain("Hidden latest sibling branch output.");
  });

  it("omits agent output when the current branch has no completed renderable output", async () => {
    const harness = await createManualTakeoverHarness({
      resolveCurrentBranchContext: () => ({
        currentTurnId: "turn-streaming",
        visibleTurnIds: ["turn-streaming"]
      })
    });
    harness.turns.push(
      {
        turnId: "turn-streaming",
        sessionId: "session-parent",
        status: "running",
        startedAt: "2026-05-10T00:00:00Z",
        finalMessageId: "message-streaming-final",
        messageIds: ["message-streaming-final"]
      },
      {
        turnId: "turn-hidden-latest",
        sessionId: "session-parent",
        status: "completed",
        startedAt: "2026-05-10T00:01:00Z",
        completedAt: "2026-05-10T00:01:01Z",
        finalMessageId: "message-hidden-final",
        messageIds: ["message-hidden-final"]
      }
    );
    harness.messageBlocks.push(
      {
        blockId: "message-streaming-final:md",
        messageId: "message-streaming-final",
        sessionId: "session-parent",
        turnId: "turn-streaming",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Partial streaming branch output.",
        startedAt: "2026-05-10T00:00:00Z"
      },
      {
        blockId: "message-hidden-final:md",
        messageId: "message-hidden-final",
        sessionId: "session-parent",
        turnId: "turn-hidden-latest",
        role: "assistant",
        phase: "final_answer",
        kind: "markdown",
        text: "Hidden latest sibling branch output.",
        startedAt: "2026-05-10T00:01:00Z",
        completedAt: "2026-05-10T00:01:01Z"
      }
    );

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);

    const initialPrompt = String(harness.commands[0]?.content ?? "");
    expect(initialPrompt).not.toContain("Agent output:");
    expect(initialPrompt).not.toContain("Partial streaming branch output.");
    expect(initialPrompt).not.toContain("Hidden latest sibling branch output.");
  });

  it("does not use session-wide latest output when branch context resolution is unavailable", async () => {
    const harness = await createManualTakeoverHarness({
      resolveCurrentBranchContext: () => undefined
    });
    harness.turns.push({
      turnId: "turn-hidden-latest",
      sessionId: "session-parent",
      status: "completed",
      startedAt: "2026-05-10T00:01:00Z",
      completedAt: "2026-05-10T00:01:01Z",
      finalMessageId: "message-hidden-final",
      messageIds: ["message-hidden-final"]
    });
    harness.messageBlocks.push({
      blockId: "message-hidden-final:md",
      messageId: "message-hidden-final",
      sessionId: "session-parent",
      turnId: "turn-hidden-latest",
      role: "assistant",
      phase: "final_answer",
      kind: "markdown",
      text: "Session-wide latest output.",
      startedAt: "2026-05-10T00:01:00Z",
      completedAt: "2026-05-10T00:01:01Z"
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);

    const initialPrompt = String(harness.commands[0]?.content ?? "");
    expect(initialPrompt).not.toContain("Agent output:");
    expect(initialPrompt).not.toContain("Session-wide latest output.");
  });

  it("omits preset desc metadata from the takeover agent prompt", async () => {
    const harness = await createManualTakeoverHarness();
    await harness.presetStore.upsert({
      presetId: "custom_review",
      prompt:
        "desc: Agent-facing preset picker copy that should not reach takeover.\n\n# Custom Review\n\nOnly this instruction should reach the takeover agent."
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "custom_review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);

    const initialPrompt = String(harness.commands[0]?.content ?? "");
    expect(initialPrompt).toContain("# Custom Review");
    expect(initialPrompt).toContain(
      "Only this instruction should reach the takeover agent."
    );
    expect(initialPrompt).not.toContain(
      "Agent-facing preset picker copy that should not reach takeover"
    );
    expect(initialPrompt).not.toContain("desc:");
  });

  it("does not synthesize provider identity for configured takeover runs", async () => {
    const harness = await createManualTakeoverHarness({
      resolveProviderSessionHandle: () => undefined
    });
    const launchTakeover = vi
      .spyOn(
        harness.service as unknown as {
          launchTakeover: (...args: unknown[]) => Promise<unknown>;
        },
        "launchTakeover"
      )
      .mockRejectedValue(new Error("stop after request capture"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await harness.service.setManualTakeover({
        sessionId: "session-parent",
        presetId: "review"
      });
      await waitFor(() => launchTakeover.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(launchTakeover.mock.calls[0]?.[0]).toMatchObject({
        parentSessionId: "session-parent",
        requestedBy: {
          engineId: "codex"
        }
      });
      expect(
        (
          launchTakeover.mock.calls[0]?.[0] as {
            requestedBy?: { providerSessionId?: string };
          }
        )?.requestedBy?.providerSessionId
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
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

  it("requires presetId for start while allowing help without presetId", async () => {
    const harness = await createManualTakeoverHarness();
    const smartTakeoverTool = harness.service
      .createHostTools()
      .find((tool) => tool.name === "SmartTakeover");

    const startResult = await smartTakeoverTool?.handle({
      definition: smartTakeoverTool,
      arguments: {
        action: "start"
      },
      context: {
        engineId: "codex",
        sessionId: "session-parent",
        providerSessionId: "thread-session-parent"
      }
    } as never);
    expect(startResult).toMatchObject({
      success: false,
      contentItems: [
        expect.objectContaining({
          text: expect.stringContaining("presetId is required")
        })
      ]
    });

    const helpResult = await smartTakeoverTool?.handle({
      definition: smartTakeoverTool,
      arguments: {
        action: "help"
      },
      context: {
        engineId: "codex",
        sessionId: "session-parent",
        providerSessionId: "thread-session-parent"
      }
    } as never);
    expect(helpResult).toMatchObject({
      success: true,
      contentItems: [
        expect.objectContaining({
          text: expect.stringContaining("Available presets:")
        })
      ]
    });
  });

  it("rejects manual takeover while the session has a goal", async () => {
    const harness = await createManualTakeoverHarness({
      threadGoals: [
        {
          sessionId: "session-parent",
          threadId: "thread-parent",
          objective: "Finish the current goal",
          status: "active",
          createdAt: 1700000000000,
          updatedAt: 1700000001000
        }
      ]
    });

    await expect(
      harness.service.setManualTakeover({
        sessionId: "session-parent",
        presetId: "review"
      })
    ).rejects.toThrow("mutually exclusive with goals");
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });
  });

  it("rejects SmartTakeover start while the session has a goal", async () => {
    const harness = await createManualTakeoverHarness({
      threadGoals: [
        {
          sessionId: "session-parent",
          threadId: "thread-parent",
          objective: "Finish the current goal",
          status: "active",
          createdAt: 1700000000000,
          updatedAt: 1700000001000
        }
      ]
    });
    const smartTakeoverTool = harness.service
      .createHostTools()
      .find((tool) => tool.name === "SmartTakeover");

    expect(
      smartTakeoverTool?.isAvailable?.({
        engineId: "codex",
        sessionId: "session-parent"
      })
    ).toBe(false);

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
      success: false,
      contentItems: [
        expect.objectContaining({
          text: expect.stringContaining("mutually exclusive with goals")
        })
      ]
    });
  });

  it("returns a successful no-op for identical SmartTakeover start", async () => {
    const harness = await createManualTakeoverHarness();
    const parent = harness.sessions.get("session-parent");
    if (parent) {
      parent.status = "running";
    }
    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review",
      context: "Stable task context."
    });
    const smartTakeoverTool = harness.service
      .createHostTools()
      .find((tool) => tool.name === "SmartTakeover");

    const result = await smartTakeoverTool?.handle({
      definition: smartTakeoverTool,
      arguments: {
        action: "start",
        presetId: "review",
        context: "Stable task context."
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

  it("rejects SmartTakeover start when takeover is already enabled even with new config", async () => {
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
        presetId: "progress",
        context: "Replace the takeover context mid-task."
      },
      context: {
        engineId: "codex",
        sessionId: "session-parent",
        providerSessionId: "thread-session-parent"
      }
    } as never);

    expect(result).toMatchObject({
      success: false,
      contentItems: [
        expect.objectContaining({
          text: expect.stringContaining("already managed")
        })
      ]
    });
    expect(result?.contentItems[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("call SmartTakeover with action=\"stop\" first")
      })
    );
    expect(result?.contentItems[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("call SmartTakeover only once at the beginning")
      })
    );
    expect(result?.contentItems[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("original global context is reused")
      })
    );
  });

  it("allows the managed agent to stop takeover through SmartTakeover", async () => {
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
        action: "stop"
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
          text: expect.stringContaining("SmartTakeover disabled")
        })
      ]
    });
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });

    if (parent) {
      parent.status = "idle";
    }
    harness.emit({
      eventId: "event-parent-completed-after-stop",
      cursor: "cursor-parent-completed-after-stop",
      occurredAt: "2026-05-10T00:00:00Z",
      event: {
        type: "turn.completed",
        sessionId: "session-parent",
        turnId: "turn-parent",
        finishReason: "completed"
      }
    } as EventEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.sessions.has("session-takeover-1")).toBe(false);
    expect(harness.commands).toEqual([]);
  });

  it("interrupts the active takeover agent when takeover is changed", async () => {
    const harness = await createManualTakeoverHarness();
    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const activeState = harness.service.getSessionState("session-parent");
    const takeoverSession = harness.sessions.get(activeState.takeoverSessionId!);
    if (takeoverSession) {
      takeoverSession.status = "running";
      takeoverSession.lastTurnId = "turn-takeover-active";
    }
    harness.turns.push({
      turnId: "turn-takeover-active",
      sessionId: activeState.takeoverSessionId!,
      status: "streaming",
      startedAt: "2026-05-10T00:00:02Z",
      messageIds: []
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "progress",
      context: "Use progress review now."
    });
    await waitFor(() => {
      const state = harness.service.getSessionState("session-parent");
      return (
        state.active &&
        state.presetId === "progress" &&
        state.takeoverSessionId !== activeState.takeoverSessionId
      );
    });

    expect(harness.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "interruptTurn",
          sessionId: activeState.takeoverSessionId,
          turnId: "turn-takeover-active"
        }),
        expect.objectContaining({
          type: "sendUserMessage",
          sessionId: "session-takeover-2",
          content: expect.stringContaining("Use progress review now.")
        })
      ])
    );
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

  it("forwards tool verdicts with source turns without waiting for their own turn completion", async () => {
    const harness = await createManualTakeoverHarness();

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const activeState = harness.service.getSessionState("session-parent");

    const result = await harness.submitVerdict(
      activeState.takeoverSessionId!,
      "complete",
      "Source-turn verdict should forward once.",
      "turn-takeover-tool"
    );

    expect(result?.success).toBe(true);
    expect(
      harness.commands.filter(
        (command) =>
          command.type === "sendUserMessage" &&
          command.sessionId === "session-parent" &&
          command.content === "Source-turn verdict should forward once."
      )
    ).toHaveLength(1);
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });
  });

  it("does not retry manual takeover feedback when parent feedback is rejected", async () => {
    const harness = await createManualTakeoverHarness({
      executeCommand: async (input) => ({
        commandId: input.commandId ?? "cmd",
        commandType: input.command.type,
        accepted: !(
          input.command.type === "sendUserMessage" &&
          input.command.sessionId === "session-parent"
        )
      })
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const activeState = harness.service.getSessionState("session-parent");

    const result = await harness.submitVerdict(
      activeState.takeoverSessionId!,
      "incomplete",
      "Manual review needs more work."
    );

    expect(result?.success).toBe(false);
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });
    expect(
      harness.commands.filter(
        (command) =>
          command.type === "sendUserMessage" &&
          command.sessionId === "session-parent" &&
          command.content === "Manual review needs more work."
      )
    ).toHaveLength(1);

    harness.emit({
      eventId: "event-parent-user-turn-ignored",
      cursor: "cursor-parent-user-turn-ignored",
      occurredAt: "2026-05-10T00:00:00Z",
      event: {
        type: "turn.completed",
        sessionId: "session-parent",
        turnId: "user-turn-local-echo",
        finishReason: "completed"
      }
    } as EventEnvelope);
    harness.emit({
      eventId: "event-parent-ready-after-rejection",
      cursor: "cursor-parent-ready-after-rejection",
      occurredAt: "2026-05-10T00:00:01Z",
      event: {
        type: "turn.completed",
        sessionId: "session-parent",
        turnId: "turn-parent-ready",
        finishReason: "completed"
      }
    } as EventEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      harness.commands.filter(
        (command) =>
          command.type === "sendUserMessage" &&
          command.sessionId === "session-parent" &&
          command.content === "Manual review needs more work."
      )
    ).toHaveLength(1);
  });

  it("rejects stale verdict submissions after parent feedback is rejected", async () => {
    const harness = await createManualTakeoverHarness({
      executeCommand: async (input) => ({
        commandId: input.commandId ?? "cmd",
        commandType: input.command.type,
        accepted: !(
          input.command.type === "sendUserMessage" &&
          input.command.sessionId === "session-parent"
        )
      })
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const activeState = harness.service.getSessionState("session-parent");

    const result = await harness.submitVerdict(
      activeState.takeoverSessionId!,
      "incomplete",
      "Rejected feedback should close the takeover run."
    );

    expect(result?.success).toBe(false);
    expect(harness.service.isActiveTakeoverRun(activeState.takeoverSessionId!)).toBe(
      false
    );
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "none",
      active: false
    });

    const staleVerdict = await harness.submitVerdict(
      activeState.takeoverSessionId!,
      "incomplete",
      "This should not be accepted."
    );
    expect(staleVerdict?.success).toBe(false);
  });

  it("uses the injected parent command executor for takeover feedback", async () => {
    const harness = await createManualTakeoverHarness();
    const parentCommands: Array<Record<string, unknown>> = [];
    harness.service.setParentCommandExecutor(async (input) => {
      parentCommands.push(input.command);
      return {
        commandId: input.commandId ?? "cmd-parent",
        commandType: input.command.type,
        accepted: true
      };
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const activeState = harness.service.getSessionState("session-parent");

    const result = await harness.submitVerdict(
      activeState.takeoverSessionId!,
      "incomplete",
      "Feedback should go through the injected parent executor."
    );

    expect(result?.success).toBe(true);
    expect(parentCommands).toEqual([
      expect.objectContaining({
        type: "sendUserMessage",
        sessionId: "session-parent",
        content: "Feedback should go through the injected parent executor."
      })
    ]);
    expect(
      harness.commands.filter(
        (command) =>
          command.type === "sendUserMessage" &&
          command.sessionId === "session-parent" &&
          command.content === "Feedback should go through the injected parent executor."
      )
    ).toHaveLength(0);
  });

  it("does not retry rejected feedback after same-preset takeover is reconfigured", async () => {
    const harness = await createManualTakeoverHarness({
      executeCommand: async (input) => ({
        commandId: input.commandId ?? "cmd",
        commandType: input.command.type,
        accepted: !(
          input.command.type === "sendUserMessage" &&
          input.command.sessionId === "session-parent"
        )
      })
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review",
      context: "old context"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const oldState = harness.service.getSessionState("session-parent");

    const result = await harness.submitVerdict(
      oldState.takeoverSessionId!,
      "incomplete",
      "Old feedback must not retry after reconfigure."
    );
    expect(result?.success).toBe(false);

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review",
      context: "new context"
    });

    await waitFor(
      () =>
        harness.service.getSessionState("session-parent").context === "new context" &&
        harness.service.getSessionState("session-parent").active
    );
    expect(harness.subscriberCount()).toBe(1);
    expect(harness.service.isActiveTakeoverRun(oldState.takeoverSessionId!)).toBe(
      false
    );

    harness.emit({
      eventId: "event-parent-ready-after-reconfigure",
      cursor: "cursor-parent-ready-after-reconfigure",
      occurredAt: "2026-05-10T00:00:00Z",
      event: {
        type: "turn.completed",
        sessionId: "session-parent",
        turnId: "turn-parent-ready-after-reconfigure",
        finishReason: "completed"
      }
    } as EventEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      harness.commands.filter(
        (command) =>
          command.type === "sendUserMessage" &&
          command.sessionId === "session-parent" &&
          command.content === "Old feedback must not retry after reconfigure."
      )
    ).toHaveLength(1);
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "managed",
      active: true,
      context: "new context"
    });
  });

  it("ignores old parent feedback receipt when same-preset takeover is reconfigured mid-forward", async () => {
    const parentFeedback = createDeferred<{
      commandId: string;
      commandType: string;
      accepted: boolean;
    }>();
    const harness = await createManualTakeoverHarness({
      executeCommand: async (input) => {
        if (
          input.command.type === "sendUserMessage" &&
          input.command.sessionId === "session-parent"
        ) {
          return parentFeedback.promise;
        }
        return {
          commandId: input.commandId ?? "cmd",
          commandType: input.command.type,
          accepted: true
        };
      }
    });

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review",
      context: "old context"
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    const oldState = harness.service.getSessionState("session-parent");

    const resultPromise = harness.submitVerdict(
      oldState.takeoverSessionId!,
      "complete",
      "Old complete verdict must not clear new config."
    );
    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "sendUserMessage" &&
          command.sessionId === "session-parent" &&
          command.content === "Old complete verdict must not clear new config."
      )
    );

    await harness.service.setManualTakeover({
      sessionId: "session-parent",
      presetId: "review",
      context: "new context"
    });
    await waitFor(
      () => harness.service.getSessionState("session-parent").context === "new context"
    );

    parentFeedback.resolve({
      commandId: "cmd-parent-feedback",
      commandType: "sendUserMessage",
      accepted: true
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: false
    });
    await waitFor(() => harness.service.getSessionState("session-parent").active);
    expect(harness.service.getSessionState("session-parent")).toMatchObject({
      role: "managed",
      active: true,
      context: "new context"
    });
    expect(harness.service.isTakeoverEnabled("session-parent")).toBe(true);
  });

  it("unsubscribes immediately when takeover turn completion wait is cancelled", async () => {
    const baseDir = await createTempDir();
    const subscribers = new Set<(envelope: EventEnvelope) => void>();
    const service = new SmartTakeoverService({
      runtimeService: {
        getSession: () => undefined,
        getSnapshot: () => ({
          conversations: [],
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
          cursor: "cursor-wait-start"
        }),
        subscribeFromCursor: (handler: (envelope: EventEnvelope) => void) => {
          subscribers.add(handler);
          return () => {
            subscribers.delete(handler);
          };
        }
      } as never,
      presetStore: new TakeoverPresetStore({ baseDir })
    });
    const config = {
      configId: "config-1",
      presetId: "review",
      args: {
        action: "start",
        presetId: "review"
      },
      source: "manual"
    };
    const run = {
      runId: "run-1",
      configId: "config-1",
      parentSessionId: "session-parent",
      takeoverSessionId: "session-takeover",
      presetId: "review",
      args: {
        action: "start",
        presetId: "review"
      },
      createdAt: "2026-05-10T00:00:00Z",
      source: "manual"
    };
    const internals = service as unknown as {
      runsById: Map<string, typeof run>;
      runIdByParentSessionId: Map<string, string>;
      takeoverConfigByParentSessionId: Map<string, typeof config>;
      cancelRun: (runId: string, reason: string) => void;
      waitForTakeoverTurnCompletion: (input: {
        run: typeof run;
        takeoverSessionId: string;
        turnId: string;
        timeoutMs: number;
      }) => Promise<void>;
    };
    internals.runsById.set(run.runId, run);
    internals.runIdByParentSessionId.set(run.parentSessionId, run.runId);
    internals.takeoverConfigByParentSessionId.set(run.parentSessionId, config);

    const wait = internals.waitForTakeoverTurnCompletion({
      run,
      takeoverSessionId: "session-takeover",
      turnId: "turn-never-completes",
      timeoutMs: 3_000
    });
    await waitFor(() => subscribers.size === 1);

    internals.cancelRun(run.runId, "Takeover was cancelled.");

    await expect(wait).rejects.toThrow("Takeover run was cancelled.");
    expect(subscribers.size).toBe(0);
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
        return () => new Date(Date.UTC(2026, 4, 10, 0, 0, ++tick)).toISOString();
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
    await waitFor(
      () =>
        serviceInternals.runsById.size === 0 &&
        serviceInternals.runIdByTakeoverSessionId.size === 0 &&
        serviceInternals.pendingVerdictResolvers.size === 0
    );
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
