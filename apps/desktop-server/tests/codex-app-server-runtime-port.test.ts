import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import type { DomainSnapshot } from "@another-workbench/shared";
import {
  clearCodexTurnChangesStore,
  getRecordedCodexTurnChanges
} from "../src/engine-extensions/codex/turn-changes-store.js";
import {
  clearCodexHookActivityStore,
  getRecordedCodexHookActivity
} from "../src/engine-extensions/codex/hook-activity-store.js";
import { HostToolRegistry } from "../src/host-tools.js";
import { createReadSessionHostTool } from "../src/read-session-host-tool.js";
import {
  createSmartTakeoverHostTool,
  type SmartTakeoverRequest
} from "../src/smart-takeover-tool.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)
);

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

const readRequestLog = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const readSessionSnapshot: DomainSnapshot = {
  conversations: [
    {
      conversationId: "conversation-1",
      participantEngineIds: ["codex"],
      activeSessionId: "session-read-target",
      sessionIds: ["session-read-target"],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z"
    }
  ],
  sessions: [
    {
      sessionId: "session-read-target",
      conversationId: "conversation-1",
      engineId: "codex",
      status: "idle",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z"
    }
  ],
  turns: [
    {
      turnId: "turn-read-target",
      sessionId: "session-read-target",
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-06-06T00:00:10.000Z",
      completedAt: "2026-06-06T00:00:20.000Z",
      finalMessageId: "assistant-read-final",
      messageIds: ["user-read", "assistant-read-final"],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: [],
      interactionRequestIds: []
    }
  ],
  messageBlocks: [
    {
      blockId: "user-read-block",
      messageId: "user-read",
      sessionId: "session-read-target",
      turnId: "turn-read-target",
      role: "user",
      kind: "plain_text",
      text: "Read this target session.",
      startedAt: "2026-06-06T00:00:10.000Z"
    },
    {
      blockId: "assistant-read-final-block",
      messageId: "assistant-read-final",
      sessionId: "session-read-target",
      turnId: "turn-read-target",
      role: "assistant",
      kind: "markdown",
      phase: "final_answer",
      text: "Session final from dynamic read tool.",
      startedAt: "2026-06-06T00:00:20.000Z"
    }
  ],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  runtimeInteractions: [],
  participants: [],
  sessionRelations: []
};

describe("Codex app-server runtime port", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    clearCodexTurnChangesStore();
    clearCodexHookActivityStore();
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      if (dispose) {
        await dispose();
      }
    }
  });

  it("sends expected JSON-RPC payloads for resume and refresh helpers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-rpc-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });

      await port.interruptThread("thread-1");
      await port.unsubscribeThread("thread-1");
      await port.resumeThread("thread-1");
      await port.reloadUserConfig();
      await port.reloadMcpServers();
      await port.listSkills({
        forceReload: true
      });

      const requests = readRequestLog(requestLogPath);
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "turn/interrupt",
            params: {
              threadId: "thread-1",
              turnId: ""
            }
          }),
          expect.objectContaining({
            method: "thread/unsubscribe",
            params: {
              threadId: "thread-1"
            }
          }),
          expect.objectContaining({
            method: "thread/resume",
            params: expect.objectContaining({
              threadId: "thread-1"
            })
          }),
          expect.objectContaining({
            method: "config/batchWrite",
            params: {
              edits: [],
              reloadUserConfig: true
            }
          }),
          expect.objectContaining({
            method: "skills/list",
            params: {
              forceReload: true
            }
          })
        ])
      );
      const mcpReloadRequest = requests.find(
        (request) => request.method === "config/mcpServer/reload"
      );
      expect(mcpReloadRequest).toEqual(
        expect.objectContaining({
          method: "config/mcpServer/reload"
        })
      );
      expect(mcpReloadRequest).not.toHaveProperty("params");
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("reports best-effort interrupt failures without rejecting resume callers", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());
    const runtimeErrors: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "runtime.error") {
        runtimeErrors.push(event.params);
      }
    });

    await port.start({
      env: {
        FAKE_CODEX_INTERRUPT_ERROR: "no active turn to interrupt"
      }
    });

    await expect(
      port.interruptThread("thread-1", {
        bestEffort: true
      })
    ).resolves.toBeUndefined();
    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        code: "CODEX_TURN_INTERRUPT_FAILED",
        message: "no active turn to interrupt",
        recoverable: true,
        details: {
          threadId: "thread-1"
        }
      })
    ]);
  });

  it("maps real app-server style notifications into message, tool, and terminal events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: string[] = [];
    const chunks: string[] = [];
    const completedMessages: Array<Record<string, unknown>> = [];
    const contextUpdates: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      events.push(event.method);
      if (event.method === "message.delta") {
        chunks.push(String(event.params.delta));
      }
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
      if (event.method === "terminal.output") {
        chunks.push(String(event.params.chunk));
      }
      if (event.method === "session.context.updated") {
        contextUpdates.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-1",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "hello from test"
      }
    });

    await waitFor(() => events.includes("turn.completed"));

    expect(events).toEqual(
      expect.arrayContaining([
        "session.updated",
        "turn.started",
        "message.started",
        "message.delta",
        "message.completed",
        "tool.started",
        "tool.delta",
        "tool.completed",
        "terminal.started",
        "terminal.output",
        "terminal.completed",
        "session.context.updated",
        "turn.completed"
      ])
    );
    expect(chunks.join("")).toContain("Real Codex says: hello from test");
    expect(chunks.join("")).toContain("D:/workspace");
    expect(completedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          finalText: expect.stringContaining("Real Codex says: hello from test")
        })
      ])
    );
    expect(contextUpdates).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        contextUsage: expect.objectContaining({
          usedTokens: 1500,
          contextWindow: 128000,
          lastUsedTokens: 2200
        })
      })
    ]);
  });

  it("marks message.completed as final for the turn when upstream phase is final_answer", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-final-answer",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger final-answer"
      }
    });

    await waitFor(() => completedMessages.length > 0);

    expect(completedMessages).toEqual([
      expect.objectContaining({
        finalText: "Real Codex says: please trigger final-answer\n",
        phase: "final_answer",
        isFinalForTurn: true
      })
    ]);
  });

  it("preserves commentary phase without marking the message as final", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-commentary",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger commentary"
      }
    });

    await waitFor(() => completedMessages.length > 0);

    expect(completedMessages).toEqual([
      expect.objectContaining({
        finalText: "Real Codex says: please trigger commentary\n",
        phase: "commentary"
      })
    ]);
    expect(completedMessages[0]).not.toHaveProperty("isFinalForTurn");
  });

  it("maps reasoning and web search process items into generic tool events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-process-events",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger process-events"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^reason-empty-/)
          })
        })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^reason-/),
            toolName: "reasoning",
            inputSummary: "Reasoning"
          })
        }),
        expect.objectContaining({
          method: "tool.delta",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^reason-/),
            delta: "Looking up current market data.\n"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^reason-/),
            outputSummary: "Looking up current market data."
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringContaining(":reasoning:"),
            outputSummary: "Comparing low-power CPU options."
          })
        }),
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^web-/),
            toolName: "webSearch",
            inputSummary: expect.stringContaining("mini PC low power CPUs")
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringContaining(":webSearch:"),
            status: "completed"
          })
        }),
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^compact-/),
            toolName: "contextCompaction",
            inputSummary: "compacting..."
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: expect.stringMatching(/^compact-/),
            outputSummary: "compaction finished"
          })
        })
      ])
    );
  });

  it("maps raw custom tool response items into a visible tool lifecycle", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-raw-custom-tool",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger raw-custom-tool"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    const toolCallId = `raw-custom-tool:${turnId}:apply-patch-${turnId}`;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            toolName: "apply_patch",
            inputSummary: expect.stringContaining("*** Begin Patch")
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            status: "completed",
            outputSummary: expect.stringContaining("Success. Updated")
          })
        })
      ])
    );
  });

  it("maps output-only raw custom tool response items when the item carries a name", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-raw-custom-tool-output-only",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger raw-custom-tool-output-only"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    const toolCallId = `raw-custom-tool:${turnId}:notify-${turnId}`;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            toolName: "notify"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId,
            status: "completed",
            outputSummary: "background notification"
          })
        })
      ])
    );
  });

  it("maps canonical image view and generation items into visible image activity", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-image-items",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger image-items"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `image-view-${turnId}`,
            toolName: "imageView",
            inputSummary: "D:/workspace/sample.png"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `image-view-${turnId}`,
            status: "completed",
            outputSummary: expect.stringContaining(
              "![Viewed image](file:///D:/workspace/sample.png)"
            )
          })
        }),
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `image-generation-${turnId}`,
            toolName: "imageGeneration",
            inputSummary: "A quiet dashboard screenshot"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-1",
            turnId,
            toolCallId: `image-generation-${turnId}`,
            status: "completed",
            outputSummary: expect.stringContaining(
              "![Generated image](file:///D:/workspace/generated.png)"
            )
          })
        })
      ])
    );
  });

  it("diagnoses unsupported canonical and raw Codex items once per type", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(async () => {
      warn.mockRestore();
      await port.stop();
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-unhandled-diagnostics",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger unhandled-diagnostics"
      }
    });

    await waitFor(() => events.some((event) => event.method === "turn.completed"));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[another-workbench] Ignored unsupported Codex ThreadItem.",
      expect.objectContaining({
        method: "item/completed",
        sessionId: "session-1",
        itemType: "plan"
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "[another-workbench] Ignored unsupported Codex raw ResponseItem.",
      expect.objectContaining({
        method: "rawResponseItem/completed",
        sessionId: "session-1",
        itemType: "tool_search_call"
      })
    );
  });

  it("maps app-server error notifications from TurnError payloads", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const runtimeErrors: Array<Record<string, unknown>> = [];
    const completedTurns: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "runtime.error") {
        runtimeErrors.push(event.params);
      }
      if (event.method === "turn.completed") {
        completedTurns.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-runtime-error",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger runtime-error"
      }
    });

    await waitFor(() => runtimeErrors.length > 0 && completedTurns.length > 0);

    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        code: "other",
        message: "Boom from app-server",
        details: {
          additionalDetails: "extra details"
        },
        recoverable: false
      })
    ]);
    expect(completedTurns).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        finishReason: "failed"
      })
    ]);
  });

  it("marks app-server retrying error notifications as recoverable", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const runtimeErrors: Array<Record<string, unknown>> = [];
    const completedTurns: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "runtime.error") {
        runtimeErrors.push(event.params);
      }
      if (event.method === "turn.completed") {
        completedTurns.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-recoverable-runtime-error",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger recoverable-runtime-error"
      }
    });

    await waitFor(() => runtimeErrors.length > 0);

    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        code: "CODEX_APP_SERVER_ERROR",
        message: "Reconnecting... 1/5",
        recoverable: true
      })
    ]);
    expect(completedTurns).toEqual([]);
  });

  it("round-trips approval requests and resumes the turn after server confirmation", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-approval",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger approval"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "approval.requested")
    );

    const requestId = events.find((event) => event.method === "approval.requested")
      ?.params.requestId;

    expect(requestId).toBeDefined();

    await port.request({
      id: "approve-1",
      method: "approval/respond",
      params: {
        sessionId: "session-1",
        requestId,
        action: "approve"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session.updated",
          params: expect.objectContaining({
            conversationId: "conversation-1",
            status: "awaiting_approval"
          })
        }),
        expect.objectContaining({
          method: "approval.requested"
        }),
        expect.objectContaining({
          method: "approval.resolved",
          params: expect.objectContaining({
            action: "approve"
          })
        }),
        expect.objectContaining({
          method: "session.updated",
          params: expect.objectContaining({
            conversationId: "conversation-1",
            status: "running"
          })
        }),
        expect.objectContaining({
          method: "tool.started"
        }),
        expect.objectContaining({
          method: "terminal.output",
          params: expect.objectContaining({
            chunk: "approved\n"
          })
        }),
        expect.objectContaining({
          method: "turn.completed"
        })
      ])
    );
  });

  it("grants requested permission profile when approving permissions requests", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-permissions-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-permissions",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger permissions-approval"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.requested")
      );

      const requestId = events.find((event) => event.method === "approval.requested")
        ?.params.requestId;

      await port.request({
        id: "approve-permissions",
        method: "approval/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "approve"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.resolved")
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            permissions: {
              network: {
                domains: ["example.com"]
              },
              fileSystem: {
                entries: [
                  {
                    path: "D:/workspace",
                    access: "read"
                  }
                ]
              }
            },
            scope: "turn"
          }
        })
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("writes object-valued command approval decisions unchanged", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-object-approval-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-object-approval",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger object-approval"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.requested")
      );

      const requestId = events.find((event) => event.method === "approval.requested")
        ?.params.requestId;
      const decision = {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow"
          }
        }
      };

      await port.request({
        id: "approve-object-decision",
        method: "approval/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "approve",
          decision
        }
      });

      await waitFor(() =>
        readRequestLog(requestLogPath).some(
          (request) => String(request.id) === String(requestId) && request.result
        )
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            decision
          }
        })
      );
      expect(
        events.find((event) => event.method === "approval.requested")?.params
      ).toEqual(
        expect.objectContaining({
          availableActions: expect.arrayContaining(["applyNetworkPolicyAmendment"]),
          metadata: expect.objectContaining({
            availableDecisions: expect.arrayContaining([decision])
          })
        })
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("falls back to an available object approval decision when explicit strings are invalid", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-object-approval-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-object-approval-invalid-string",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger object-approval"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "approval.requested")
      );

      const requestId = events.find((event) => event.method === "approval.requested")
        ?.params.requestId;
      const decision = {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow"
          }
        }
      };

      await port.request({
        id: "approve-object-invalid-string",
        method: "approval/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "approve",
          decision: "accept"
        }
      });

      await waitFor(() =>
        readRequestLog(requestLogPath).some(
          (request) => String(request.id) === String(requestId) && request.result
        )
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            decision
          }
        })
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("round-trips tool user input requests through runtime interactions", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-user-input",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger user-input"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.requested")
    );

    const requestId = events.find((event) => event.method === "interaction.requested")
      ?.params.requestId;

    await port.request({
      id: "interaction-1",
      method: "interaction/respond",
      params: {
        sessionId: "session-1",
        requestId,
        action: "submit",
        answers: {
          confirm: ["yes"]
        }
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.resolved")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "interaction.requested",
          params: expect.objectContaining({
            interactionKind: "tool_user_input"
          })
        }),
        expect.objectContaining({
          method: "interaction.resolved",
          params: expect.objectContaining({
            action: "submit",
            response: {
              answers: {
                confirm: {
                  answers: ["yes"]
                }
              }
            }
          })
        })
      ])
    );
  });

  it("normalizes tool user input decline and cancel actions to submit answers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-codex-user-input-"));
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    try {
      await port.start({
        env: {
          FAKE_CODEX_REQUEST_LOG: requestLogPath
        }
      });
      await port.request({
        id: "turn-user-input-cancel",
        method: "turn/start",
        params: {
          sessionId: "session-1",
          content: "please trigger user-input"
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "interaction.requested")
      );

      const requestId = events.find((event) => event.method === "interaction.requested")
        ?.params.requestId;

      await port.request({
        id: "interaction-cancel",
        method: "interaction/respond",
        params: {
          sessionId: "session-1",
          requestId,
          action: "cancel",
          answers: {
            confirm: ["no"]
          }
        }
      });

      await waitFor(() =>
        events.some((event) => event.method === "interaction.resolved")
      );

      const responsePayload = readRequestLog(requestLogPath).find(
        (request) => String(request.id) === String(requestId) && request.result
      );
      expect(responsePayload).toEqual(
        expect.objectContaining({
          result: {
            answers: {
              confirm: {
                answers: ["no"]
              }
            }
          }
        })
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "interaction.resolved",
            params: expect.objectContaining({
              action: "submit"
            })
          })
        ])
      );
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true
      });
    }
  });

  it("keeps out-of-band MCP elicitation session-scoped when turnId is null", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-mcp-elicitation-null",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger mcp-elicitation-null"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.requested")
    );

    const requested = events.find((event) => event.method === "interaction.requested");
    const requestId = requested?.params.requestId;

    expect(requested?.params).toEqual(
      expect.objectContaining({
        interactionKind: "mcp_elicitation",
        sessionId: "session-1"
      })
    );
    expect(requested?.params).not.toHaveProperty("turnId");
    expect(
      events.some(
        (event) =>
          event.method === "turn.started" && event.params.turnId === requestId
      )
    ).toBe(false);

    await port.request({
      id: "interaction-mcp-null",
      method: "interaction/respond",
      params: {
        sessionId: "session-1",
        requestId,
        action: "accept",
        content: {
          confirmed: true
        }
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "interaction.resolved")
    );

    const resolved = events.find((event) => event.method === "interaction.resolved");
    expect(resolved?.params).toEqual(
      expect.objectContaining({
        action: "accept",
        response: {
          action: "accept",
          content: {
            confirmed: true
          },
          _meta: null
        }
      })
    );
    expect(resolved?.params).not.toHaveProperty("turnId");

    const sessionUpdates = events.filter(
      (event) => event.method === "session.updated"
    );
    expect(sessionUpdates.at(-1)?.params).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        status: "idle"
      })
    );
  });

  it("maps mcp tool lifecycle and progress notifications", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-mcp",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger mcp-tool"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolName: "mcp.browser.open",
            inputSummary: expect.stringContaining("https://example.com")
          })
        }),
        expect.objectContaining({
          method: "tool.delta",
          params: expect.objectContaining({
            delta: "opening page"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            status: "completed",
            outputSummary: "opened"
          })
        })
      ])
    );
  });

  it("does not override codex sandbox and approval defaults unless explicitly selected", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start({
      cwd: "D:/workspace/another-workbench/apps/desktop"
    });
    await port.request({
      id: "turn-thread-start-defaults",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "__THREAD_START_PARAMS__"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")?.finalText
    );

    expect(finalText).toContain('"cwd":"D:/workspace/another-workbench/apps/desktop"');
    expect(finalText).not.toContain('"sandbox":"workspace-write"');
    expect(finalText).not.toContain('"approvalPolicy":"on-request"');
  });

  it("uses command-scoped cwd when starting a Codex thread", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start({
      cwd: "D:/workspace/another-workbench/apps/desktop"
    });
    await port.request({
      id: "turn-thread-start-command-cwd",
      method: "turn/start",
      params: {
        sessionId: "session-command-cwd",
        content: "__THREAD_START_PARAMS__",
        cwd: "D:/workspace"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")?.finalText
    );

    expect(finalText).toContain('"cwd":"D:/workspace"');
  });

  it("maps subagent collaboration items into tool activity and child session events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-collab",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger subagent"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            toolName: "subagent.spawn",
            inputSummary: expect.stringContaining("Review this file")
          })
        }),
        expect.objectContaining({
          method: "session.created",
          params: expect.objectContaining({
            sessionId: "codex-thread:sub-thread-1",
            relation: expect.objectContaining({
              parentSessionId: "session-1",
              childSessionId: "codex-thread:sub-thread-1",
              relationType: "subagent"
            })
          })
        }),
        expect.objectContaining({
          method: "session.updated",
          params: expect.objectContaining({
            sessionId: "codex-thread:sub-thread-1",
            metadata: expect.objectContaining({
              providerSessionId: "sub-thread-1"
            })
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            toolCallId: "collab-turn-1",
            outputSummary: expect.stringContaining("sub-thread-1: completed")
          })
        })
      ])
    );
    expect(port.getThreadIdForSession("codex-thread:sub-thread-1")).toBe("sub-thread-1");
  });

  it("passes through explicit sandbox and approval selections", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    port.subscribe((event) => {
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start({
      cwd: "D:/workspace/another-workbench/apps/desktop",
      metadata: {
        selectedConfig: {
          sandbox: "danger-full-access",
          approvalPolicy: "never"
        }
      }
    });
    await port.request({
      id: "turn-thread-start-explicit",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "__THREAD_START_PARAMS__"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")?.finalText
    );

    expect(finalText).toContain('"sandbox":"danger-full-access"');
    expect(finalText).toContain('"approvalPolicy":"never"');
  });

  it("registers SmartTakeover as a Codex dynamic tool and resolves the calling session", async () => {
    const observedRequests: SmartTakeoverRequest[] = [];
    const hostTools = new HostToolRegistry([
      createSmartTakeoverHostTool({
        onRequest: (request) => {
          observedRequests.push(request);
        }
      })
    ]);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1",
      hostTools
    });
    disposers.push(() => port.stop());

    const completedMessages: Array<Record<string, unknown>> = [];
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
      if (event.method === "message.completed") {
        completedMessages.push(event.params);
      }
    });

    await port.start();
    await port.request({
      id: "turn-thread-start-host-tools",
      method: "turn/start",
      params: {
        sessionId: "session-registry",
        content: "__THREAD_START_PARAMS__"
      }
    });

    await waitFor(() =>
      completedMessages.some((params) => typeof params.finalText === "string")
    );

    const finalText = String(
      completedMessages.find((params) => typeof params.finalText === "string")
        ?.finalText
    );
    expect(finalText).toContain('"dynamicTools"');
    expect(finalText).toContain('"namespace":"another_workbench"');
    expect(finalText).toContain('"name":"SmartTakeover"');

    await port.request({
      id: "turn-smart-takeover",
      method: "turn/start",
      params: {
        sessionId: "session-smart",
        content: "please trigger smart-takeover"
      }
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.method === "turn.completed" &&
          event.params.sessionId === "session-smart"
      )
    );

    expect(observedRequests).toEqual([
      expect.objectContaining({
        parentSessionId: "session-smart",
        sourceToolCallId: expect.stringMatching(/^smart-takeover-/),
        requestedBy: expect.objectContaining({
          engineId: "codex",
          providerSessionId: port.getThreadIdForSession("session-smart")
        }),
        arguments: {
          objective: "Confirm caller identity"
        }
      })
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-smart",
            toolName: "another_workbench.SmartTakeover"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-smart",
            outputSummary: expect.stringContaining("session session-smart")
          })
        })
      ])
    );
  });

  it("invokes read_session through the Codex dynamic tool path", async () => {
    const hostTools = new HostToolRegistry([
      createReadSessionHostTool({
        getSnapshot: () => readSessionSnapshot
      })
    ]);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1",
      hostTools
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-read-session-tool",
      method: "turn/start",
      params: {
        sessionId: "session-reader",
        content: "please trigger read-session-tool"
      }
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.method === "tool.completed" &&
          event.params.sessionId === "session-reader"
      )
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tool.started",
          params: expect.objectContaining({
            sessionId: "session-reader",
            toolName: "another_workbench.read_session"
          })
        }),
        expect.objectContaining({
          method: "tool.completed",
          params: expect.objectContaining({
            sessionId: "session-reader",
            outputSummary: expect.stringContaining(
              "Session final from dynamic read tool."
            )
          })
        })
      ])
    );
  });

  it("records fileChange items for the Codex turn-changes extension without emitting shared diff events", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-file-change",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger file-change"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "turn.diff.updated"
        })
      ])
    );
    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(
      getRecordedCodexTurnChanges("session-1", turnId)
    ).toMatchObject({
      mergedDiff: `diff --git a/apps/desktop/abc.txt b/apps/desktop/abc.txt
--- a/apps/desktop/abc.txt
+++ b/apps/desktop/abc.txt
@@ -1 +1,3 @@
-
+第一行内容
+第二行内容
+第三行内容`,
      changes: [
        expect.objectContaining({
          path: "apps/desktop/abc.txt",
          changeKind: "update"
        })
      ]
    });
  });

  it("records hook lifecycle notifications for the Codex hook activity extension", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger hook-activity"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            engineId: "codex",
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
    expect(getRecordedCodexHookActivity("session-1", turnId)).toMatchObject({
      runs: [
        expect.objectContaining({
          id: `hook-${turnId}`,
          eventName: "preToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          status: "completed",
          durationMs: 25,
          entries: [
            {
              kind: "warning",
              text: "checked command policy"
            },
            {
              kind: "context",
              text: "workspace hook context"
            }
          ]
        })
      ]
    });
  });

  it("attaches null-turn hook activity to the active Codex turn", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(() => port.stop());

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-thread-scope-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger thread-scope hook-activity"
      }
    });

    await waitFor(() =>
      events.some((event) => event.method === "turn.completed")
    );

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            engineId: "codex",
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
    expect(getRecordedCodexHookActivity("session-1", turnId)).toMatchObject({
      runs: [
        expect.objectContaining({
          id: `thread-hook-${turnId}`,
          eventName: "sessionStart",
          scope: "thread",
          status: "completed",
          entries: [
            {
              kind: "context",
              text: "thread startup hook context"
            }
          ]
        })
      ]
    });
  });

  it("matches null-turn hook completion to a prior started run after the turn completes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(async () => {
      warn.mockRestore();
      await port.stop();
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-async-thread-scope-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger async-thread-scope hook-activity"
      }
    });

    await waitFor(() => {
      const turnId = events.find(
        (event) => event.method === "turn.completed"
      )?.params.turnId;
      return (
        typeof turnId === "string" &&
        getRecordedCodexHookActivity("session-1", turnId)?.runs[0]?.status ===
          "completed"
      );
    });

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    const hookActivity = getRecordedCodexHookActivity("session-1", turnId);
    expect(hookActivity).toMatchObject({
      runs: [
        expect.objectContaining({
          id: `async-thread-hook-${turnId}`,
          eventName: "stop",
          scope: "thread",
          status: "completed",
          durationMs: 42,
          entries: [
            {
              kind: "context",
              text: "async hook completed after turn"
            }
          ]
        })
      ]
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            engineId: "codex",
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Ignoring Codex hook activity"),
      expect.anything()
    );
  });

  it("warns instead of silently dropping null-turn hook activity with no active turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: () => "conversation-1"
    });
    disposers.push(async () => {
      warn.mockRestore();
      await port.stop();
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    port.subscribe((event) => {
      events.push({
        method: event.method,
        params: event.params
      });
    });

    await port.start();
    await port.request({
      id: "turn-post-complete-hook-activity",
      method: "turn/start",
      params: {
        sessionId: "session-1",
        content: "please trigger post-complete hook-activity"
      }
    });

    await waitFor(() =>
      warn.mock.calls.some((call) =>
        String(call[0]).includes("Ignoring Codex hook activity")
      )
    );

    const turnId = String(
      events.find((event) => event.method === "turn.completed")?.params.turnId
    );
    expect(getRecordedCodexHookActivity("session-1", turnId)).toBeUndefined();
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "engineExtension.updated",
          params: expect.objectContaining({
            extensionKey: "hook-activity",
            sessionId: "session-1",
            turnId
          })
        })
      ])
    );
  });
});
