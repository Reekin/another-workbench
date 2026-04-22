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
import {
  resolveProcessExpanded,
  toggleProcessVisibility
} from "../src/ui/chat-shell/process-visibility.js";

describe("ChatShellApp inline process output", () => {
  it("lets a running turn collapse even when process output defaults open", () => {
    const initial = resolveProcessExpanded(true, undefined);
    expect(initial).toBe(true);

    const afterFirstToggle = toggleProcessVisibility({}, "turn-running", true);
    expect(resolveProcessExpanded(true, afterFirstToggle["turn-running"])).toBe(false);

    const afterSecondToggle = toggleProcessVisibility(
      afterFirstToggle,
      "turn-running",
      true
    );
    expect(resolveProcessExpanded(true, afterSecondToggle["turn-running"])).toBe(true);
    expect(afterSecondToggle).toEqual({});
  });

  it("renders process output controls inline under assistant turns", () => {
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

    expect(html).not.toContain(">Inspector<");
    expect(html).toContain("Show process output");
    expect(html).toContain("Hide process output");
    expect(html).toContain("1 tool");
    expect((html.match(/Tool activity/g) ?? []).length).toBe(1);
    expect(html).toContain('class="awb-turn__process"');
  });
});
