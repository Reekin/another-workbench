import { describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot } from "@another-workbench/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { createRendererStore } from "../src/store/store.js";

vi.mock("xterm", () => ({
  Terminal: class MockTerminal {
    public open(): void {}
    public write(): void {}
    public reset(): void {}
    public dispose(): void {}
  }
}));

import {
  ChatShellApp,
  truncateSessionHeading
} from "../src/ui/chat-shell/ChatShellApp.js";

describe("ChatShellApp header and transcript labels", () => {
  it("truncates long thread titles to 20 characters", () => {
    expect(truncateSessionHeading("  这是一个特别特别长的首轮输入标题用于验证截断  ")).toBe(
      "这是一个特别特别长的首轮输入标题用于验证…"
    );
    expect(truncateSessionHeading("short title")).toBe("short title");
    expect(truncateSessionHeading("   ")).toBe("Thread");
  });

  it("shows the assistant identity once for multiple assistant blocks in one turn", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-1",
            participantEngineIds: ["agent-codex"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-18T00:00:00.000Z",
            updatedAt: "2026-04-18T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "agent-codex",
            status: "idle",
            createdAt: "2026-04-18T00:00:00.000Z",
            updatedAt: "2026-04-18T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-18T00:01:00.000Z",
            finishedAt: "2026-04-18T00:01:20.000Z",
            messageIds: ["message-1", "message-2"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-1:md",
            messageId: "message-1",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "first line",
            actor: {
              participantId: "participant-1",
              engineId: "agent-codex"
            },
            startedAt: "2026-04-18T00:01:01.000Z"
          },
          {
            blockId: "message-2:md",
            messageId: "message-2",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "second line",
            actor: {
              participantId: "participant-1",
              engineId: "agent-codex"
            },
            startedAt: "2026-04-18T00:01:02.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [
          {
            participantId: "participant-1",
            conversationId: "conversation-1",
            engineId: "agent-codex",
            role: "primary",
            capabilities: ["chat"],
            activeSessionIds: ["session-1"]
          }
        ],
        sessionRelations: []
      })
    );

    const html = renderToStaticMarkup(<ChatShellApp store={store} />);

    expect((html.match(/agent-codex/g) ?? []).length).toBe(1);
    expect(html).toContain("first line");
    expect(html).toContain("second line");
  });
});
