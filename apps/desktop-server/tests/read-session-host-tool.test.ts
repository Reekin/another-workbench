import { describe, expect, it } from "vitest";
import type { DomainSnapshot } from "@another-workbench/shared";
import { HostToolRegistry } from "../src/host-tools.js";
import {
  createReadSessionHostTool,
  readSessionToolName,
  readSessionToolNamespace
} from "../src/read-session-host-tool.js";

const snapshot: DomainSnapshot = {
  conversations: [
    {
      conversationId: "conversation-1",
      participantEngineIds: ["codex"],
      activeSessionId: "session-1",
      sessionIds: ["session-1"],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z"
    }
  ],
  sessions: [
    {
      sessionId: "session-1",
      conversationId: "conversation-1",
      engineId: "codex",
      status: "idle",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z"
    }
  ],
  turns: [
    {
      turnId: "turn-1",
      sessionId: "session-1",
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-06-06T00:00:10.000Z",
      completedAt: "2026-06-06T00:00:20.000Z",
      finalMessageId: "assistant-final",
      messageIds: ["user-1", "assistant-final"],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: [],
      interactionRequestIds: []
    }
  ],
  messageBlocks: [
    {
      blockId: "user-1-block",
      messageId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      role: "user",
      kind: "plain_text",
      text: "Please summarize this session.",
      startedAt: "2026-06-06T00:00:10.000Z"
    },
    {
      blockId: "assistant-final-block",
      messageId: "assistant-final",
      sessionId: "session-1",
      turnId: "turn-1",
      role: "assistant",
      phase: "final_answer",
      kind: "markdown",
      text: "Session summary is ready.",
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

const invocationContext = {
  engineId: "codex",
  sessionId: "caller-session",
  providerSessionId: "thread-caller"
};

describe("createReadSessionHostTool", () => {
  it("registers as an AWB host tool definition", async () => {
    const registry = new HostToolRegistry([
      createReadSessionHostTool({
        getSnapshot: () => snapshot
      })
    ]);

    const definitions = await registry.listDefinitions({
      engineId: "codex",
      sessionId: "caller-session"
    });

    expect(definitions).toEqual([
      expect.objectContaining({
        namespace: readSessionToolNamespace,
        name: readSessionToolName,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            sessionId: expect.objectContaining({
              minLength: 1
            }),
            limit: expect.objectContaining({
              default: 50,
              maximum: 200
            }),
            maxChars: expect.objectContaining({
              default: 60000,
              maximum: 200000
            })
          }),
          required: ["sessionId"]
        })
      })
    ]);
  });

  it("returns parseable collapsed transcript JSON", async () => {
    const tool = createReadSessionHostTool({
      getSnapshot: () => snapshot
    });

    const result = await tool.handle({
      definition: tool,
      arguments: {
        sessionId: "session-1"
      },
      context: invocationContext
    });

    expect(result.success).toBe(true);
    const text = result.contentItems[0]?.type === "inputText"
      ? result.contentItems[0].text
      : "";
    const parsed = JSON.parse(text) as {
      sessionId: string;
      turns: Array<{ user: string[]; agentFinal?: string }>;
    };
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.turns[0]).toEqual(
      expect.objectContaining({
        user: ["Please summarize this session."],
        agentFinal: "Session summary is ready."
      })
    );
  });

  it("returns failed host-tool results for invalid input and unknown sessions", async () => {
    const tool = createReadSessionHostTool({
      getSnapshot: () => snapshot
    });

    await expect(
      tool.handle({
        definition: tool,
        arguments: {
          limit: 10
        },
        context: invocationContext
      })
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "sessionId is required."
          }
        ]
      })
    );

    await expect(
      tool.handle({
        definition: tool,
        arguments: {
          sessionId: "missing-session"
        },
        context: invocationContext
      })
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Unknown session: missing-session"
          }
        ]
      })
    );

    await expect(
      tool.handle({
        definition: tool,
        arguments: {
          sessionId: "session-1",
          maxChars: 200001
        },
        context: invocationContext
      })
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "maxChars must be a positive integer up to 200000 when provided."
          }
        ]
      })
    );
  });
});
