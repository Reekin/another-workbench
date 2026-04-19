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

import { ChatShellApp } from "../src/ui/chat-shell/ChatShellApp.js";

describe("ChatShellApp inspector layout", () => {
  it("moves process details into the inspector and focuses the latest assistant turn", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-1",
            participantAgentIds: ["agent-codex"],
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
            agentId: "agent-codex",
            status: "running",
            createdAt: "2026-04-18T00:00:00.000Z",
            updatedAt: "2026-04-18T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-completed",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-18T00:01:00.000Z",
            finishedAt: "2026-04-18T00:01:20.000Z",
            messageIds: ["message-completed"],
            toolCallIds: ["tool-completed"],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-running",
            sessionId: "session-1",
            status: "streaming",
            startedAt: "2026-04-18T00:02:00.000Z",
            messageIds: ["message-running"],
            toolCallIds: ["tool-running"],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-completed:md",
            messageId: "message-completed",
            sessionId: "session-1",
            turnId: "turn-completed",
            role: "assistant",
            kind: "markdown",
            text: "completed turn",
            startedAt: "2026-04-18T00:01:01.000Z"
          },
          {
            blockId: "message-running:md",
            messageId: "message-running",
            sessionId: "session-1",
            turnId: "turn-running",
            role: "assistant",
            kind: "markdown",
            text: "running turn",
            startedAt: "2026-04-18T00:02:01.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-completed",
            sessionId: "session-1",
            turnId: "turn-completed",
            toolName: "read_file",
            status: "completed",
            startedAt: "2026-04-18T00:01:02.000Z",
            finishedAt: "2026-04-18T00:01:10.000Z"
          },
          {
            toolCallId: "tool-running",
            sessionId: "session-1",
            turnId: "turn-running",
            toolName: "grep",
            status: "running",
            startedAt: "2026-04-18T00:02:02.000Z"
          }
        ],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const html = renderToStaticMarkup(<ChatShellApp store={store} />);

    expect(html).toContain(">Inspector<");
    expect(html).toContain("Turn process");
    expect(html).toContain(">turn-running<");
    expect((html.match(/Tool activity/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Process details hidden by default after completion.");
    expect(html).not.toContain("Process details stay open while the turn is still running.");
    expect(html).not.toContain('class="awb-turn__process');
  });
});
