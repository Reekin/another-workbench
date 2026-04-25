import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createCodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import {
  clearCodexTurnChangesStore,
  getRecordedCodexTurnChanges
} from "../src/engine-extensions/codex/turn-changes-store.js";

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

describe("Codex app-server runtime port", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    clearCodexTurnChangesStore();
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      if (dispose) {
        await dispose();
      }
    }
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
        isFinalForTurn: true
      })
    ]);
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
});
