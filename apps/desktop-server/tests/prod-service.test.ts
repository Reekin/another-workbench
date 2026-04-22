import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createWorkbenchRuntimeService } from "../src/prod-service.js";

const codexFixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)
);
const piFixturePath = fileURLToPath(
  new URL("./fixtures/fake-pi-acp.mjs", import.meta.url)
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

describe("prod runtime service", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      if (dispose) {
        await dispose();
      }
    }
  });

  it("uses the real Codex runtime composition instead of demo placeholder text", async () => {
    const service = createWorkbenchRuntimeService({
      codexCommandPath: process.execPath,
      codexCommandArgs: [codexFixturePath],
      piAcpCommandPath: process.execPath,
      piAcpCommandArgs: [piFixturePath]
    });
    disposers.push(() => service.dispose());

    await service.executeCommand({
      commandId: "create-codex-session",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-prod"
      }
    });

    const sessionId = service.listSessions({
      conversationId: "conversation-prod",
      includeArchived: true
    })[0]?.sessionId;

    expect(sessionId).toBeDefined();

    const deltas: string[] = [];
    service.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        deltas.push(envelope.event.delta);
      }
      if (envelope.event.type === "terminal.output") {
        deltas.push(envelope.event.chunk);
      }
    }, {
      conversationId: "conversation-prod"
    });

    await service.executeCommand({
      commandId: "send-codex",
      command: {
        type: "sendUserMessage",
        sessionId: sessionId!,
        messageId: "msg-1",
        content: "hello real codex",
        attachments: []
      }
    });

    await waitFor(() =>
      service.getSnapshot().messageBlocks.some((block) =>
        block.sessionId === sessionId &&
        block.role === "assistant" &&
        block.text.includes("Real Codex says: hello real codex")
      )
    );

    const snapshot = service.getSnapshot();
    const joinedText = deltas.join("");

    expect(joinedText).toContain("Real Codex says: hello real codex");
    expect(joinedText).not.toContain("Codex response");
    expect(
      snapshot.messageBlocks.some((block) =>
        block.messageId === "msg-1" && block.role === "user" && block.text.includes("hello real codex")
      )
    ).toBe(true);
    expect(snapshot.messageBlocks.some((block) =>
      block.text.includes("Real Codex says: hello real codex")
    )).toBe(true);
    expect(snapshot.toolCalls.some((toolCall) =>
      toolCall.toolName === "commandExecution"
    )).toBe(true);
    expect(snapshot.terminalStreams.some((stream) =>
      stream.outputText.includes("D:/workspace")
    )).toBe(true);
  });

  it("exposes pi-acp as a real ACP-backed agent with streamed transcript and tool output", async () => {
    const service = createWorkbenchRuntimeService({
      codexCommandPath: process.execPath,
      codexCommandArgs: [codexFixturePath],
      piAcpCommandPath: process.execPath,
      piAcpCommandArgs: [piFixturePath]
    });
    disposers.push(() => service.dispose());

    expect(service.listAgents().some((agent) => agent.agentId === "pi-acp")).toBe(true);

    await service.executeCommand({
      commandId: "create-pi-session",
      command: {
        type: "createSession",
        engineId: "pi-acp",
        conversationId: "conversation-pi"
      }
    });

    const sessionId = service.listSessions({
      conversationId: "conversation-pi",
      includeArchived: true
    })[0]?.sessionId;

    expect(sessionId).toBeDefined();

    const deltas: string[] = [];
    service.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        deltas.push(envelope.event.delta);
      }
      if (envelope.event.type === "tool.delta") {
        deltas.push(envelope.event.delta);
      }
    }, {
      conversationId: "conversation-pi"
    });

    await service.executeCommand({
      commandId: "send-pi",
      command: {
        type: "sendUserMessage",
        sessionId: sessionId!,
        messageId: "msg-pi-1",
        content: "hello pi agent",
        attachments: []
      }
    });

    await waitFor(() =>
      service.getSnapshot().turns.some((turn) =>
        turn.sessionId === sessionId && turn.status === "completed"
      )
    );

    const snapshot = service.getSnapshot();
    const joinedText = deltas.join("");
    const sessionBlocks = snapshot.messageBlocks.filter((block) =>
      block.sessionId === sessionId
    );
    const sessionBlockTexts = sessionBlocks.map((block) => block.text);

    expect(joinedText).toContain("Pi ACP says: hello pi agent");
    expect(sessionBlocks.length).toBeGreaterThanOrEqual(3);
    expect(
      sessionBlockTexts.some((text) => text.includes("hello pi agent"))
    ).toBe(true);
    expect(sessionBlockTexts.some((text) => text.includes("## Skills"))).toBe(true);
    expect(
      sessionBlockTexts.some((text) => text.includes("Pi ACP says: hello pi agent"))
    ).toBe(true);
    expect(snapshot.toolCalls.some((toolCall) =>
      toolCall.sessionId === sessionId &&
      toolCall.toolName === "Execute shell command" &&
      toolCall.outputSummary?.includes("D:/workspace")
    )).toBe(true);
  });
});
