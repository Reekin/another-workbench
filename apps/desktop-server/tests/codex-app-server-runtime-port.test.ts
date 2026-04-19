import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createCodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";

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
    port.subscribe((event) => {
      events.push(event.method);
      if (event.method === "message.delta") {
        chunks.push(String(event.params.delta));
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
});
