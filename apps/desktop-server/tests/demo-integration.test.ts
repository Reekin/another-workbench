import { describe, expect, it } from "vitest";
import {
  createDemoWorkbenchRuntimeService,
  createDemoWorkbenchShellService
} from "../src/demo-service.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("demo runtime fixture", () => {
  it("partially updates and clones execution preferences", async () => {
    const service = createDemoWorkbenchShellService();
    await service.updateSettings({
      executionPreferencesByEngineId: {
        codex: {
          selectedModelId: "gpt-5.5",
          modelPreferences: {
            "gpt-5.5": {
              reasoningOptionId: "high"
            }
          }
        }
      }
    });
    const firstRead = await service.getSettings();
    firstRead.executionPreferencesByEngineId.codex.selectedModelId =
      "mutated-after-read";

    await expect(service.getSettings()).resolves.toMatchObject({
      defaultNewSessionEngineId: "acp",
      executionPreferencesByEngineId: {
        codex: {
          selectedModelId: "gpt-5.5",
          modelPreferences: {
            "gpt-5.5": { reasoningOptionId: "high" }
          }
        }
      }
    });
  });

  it("streams codex events for a normal message flow", async () => {
    const service = createDemoWorkbenchRuntimeService();
    await service.executeCommand({
      commandId: "create-codex-session",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conv-codex"
      }
    });
    const codexSessionId = service.listSessions({
      conversationId: "conv-codex",
      includeArchived: true
    })[0]?.sessionId;

    expect(codexSessionId).toBeDefined();

    const received: string[] = [];
    const unsubscribe = service.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        received.push(envelope.event.delta);
      }
      if (envelope.event.type === "tool.started") {
        received.push(`tool:${envelope.event.toolName}`);
      }
      if (envelope.event.type === "terminal.output") {
        received.push(`terminal:${envelope.event.chunk.trim()}`);
      }
    }, {
      conversationId: "conv-codex"
    });

    const receipt = await service.executeCommand({
      commandId: "send-codex",
      command: {
        type: "sendUserMessage",
        sessionId: codexSessionId!,
        messageId: "msg-1",
        content: "show me the workspace plan",
        attachments: []
      }
    });

    await flushMicrotasks();
    unsubscribe();

    expect(receipt.accepted).toBe(true);
    expect(received.some((item) => item.includes("Codex response"))).toBe(true);
    expect(received).toContain("tool:exec_command");
    expect(received.some((item) => item.startsWith("terminal:> codex"))).toBe(true);

    const snapshot = service.getSnapshot();
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.messageBlocks.some((block) => block.messageId === "msg-1")).toBe(true);
    expect(
      snapshot.messageBlocks.some((block) => block.messageId === "msg-1" && block.role === "user")
    ).toBe(true);
    expect(snapshot.toolCalls[0]).toMatchObject({
      toolName: "exec_command"
    });
    expect(snapshot.terminalStreams[0]?.outputText).toContain("preparing workspace");
  });

  it("runs ACP approval flow through respondApproval", async () => {
    const service = createDemoWorkbenchRuntimeService();
    await service.executeCommand({
      commandId: "create-acp-session",
      command: {
        type: "createSession",
        engineId: "acp",
        conversationId: "conv-acp"
      }
    });
    const acpSessionId = service.listSessions({
      conversationId: "conv-acp",
      includeArchived: true
    })[0]?.sessionId;

    expect(acpSessionId).toBeDefined();

    const events: string[] = [];
    service.subscribe((envelope) => {
      events.push(envelope.event.type);
    }, {
      conversationId: "conv-acp"
    });

    await service.executeCommand({
      commandId: "send-acp",
      command: {
        type: "sendUserMessage",
        sessionId: acpSessionId!,
        messageId: "msg-1",
        content: "please approve this write operation",
        attachments: []
      }
    });

    await flushMicrotasks();
    expect(events).toContain("approval.requested");
    const requestId = service.getSnapshot().approvalRequests[0]?.requestId;

    expect(requestId).toBeDefined();

    await service.executeCommand({
      commandId: "approve-acp",
      command: {
        type: "respondApproval",
        sessionId: acpSessionId!,
        requestId: requestId!,
        action: "approve"
      }
    });

    await flushMicrotasks();

    expect(events).toContain("approval.resolved");
    expect(events).toContain("tool.completed");
    expect(events).toContain("turn.completed");

    const snapshot = service.getSnapshot();
    expect(snapshot.approvalRequests[0]).toMatchObject({
      requestId,
      status: "approved"
    });
    expect(snapshot.sessions.find((session) => session.sessionId === acpSessionId)?.status).toBe(
      "idle"
    );
  });
});
