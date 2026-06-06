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
  formatRelativeCompletedTurnAge,
  getWorkspaceSessionPage,
  resolveCurrentTakeoverState,
  truncateSessionHeading,
  workspaceMenuActionLabel
} from "../src/ui/chat-shell/ChatShellApp.js";

describe("ChatShellApp header and transcript labels", () => {
  it("truncates long thread titles to 20 characters", () => {
    expect(truncateSessionHeading("  这是一个特别特别长的首轮输入标题用于验证截断  ")).toBe(
      "这是一个特别特别长的首轮输入标题用于验证…"
    );
    expect(truncateSessionHeading("short title")).toBe("short title");
    expect(truncateSessionHeading("   ")).toBe("Thread");
  });

  it("formats sidebar completed-turn age using minute, hour, and day units", () => {
    const now = new Date("2026-05-04T12:00:00.000Z").getTime();

    expect(formatRelativeCompletedTurnAge("2026-05-04T11:55:00.000Z", now)).toBe("5m");
    expect(formatRelativeCompletedTurnAge("2026-05-04T09:30:00.000Z", now)).toBe("2h");
    expect(formatRelativeCompletedTurnAge("2026-05-01T08:00:00.000Z", now)).toBe("3d");
    expect(formatRelativeCompletedTurnAge(undefined, now)).toBeUndefined();
    expect(formatRelativeCompletedTurnAge("not-a-date", now)).toBeUndefined();
  });

  it("limits workspace session pages to ten root sessions", () => {
    const sessions = Array.from({ length: 23 }, (_, index) => `session-${index + 1}`);

    expect(getWorkspaceSessionPage(sessions, 0)).toEqual({
      pageIndex: 0,
      totalPages: 3,
      sessions: sessions.slice(0, 10)
    });
    expect(getWorkspaceSessionPage(sessions, 2)).toEqual({
      pageIndex: 2,
      totalPages: 3,
      sessions: sessions.slice(20, 23)
    });
    expect(getWorkspaceSessionPage(sessions, 99)).toMatchObject({
      pageIndex: 2,
      totalPages: 3
    });
  });

  it("labels workspace context menu actions", () => {
    expect(workspaceMenuActionLabel("schedule")).toBe("Schedule");
    expect(workspaceMenuActionLabel("open_directory")).toBe(
      "Open workspace directory"
    );
    expect(workspaceMenuActionLabel("remove_workspace")).toBe("Remove workspace");
  });

  it("guards takeover state to the active session", () => {
    const takeoverState = {
      sessionId: "session-a",
      role: "managed",
      active: true,
      presetId: "review"
    } as const;

    expect(resolveCurrentTakeoverState(takeoverState, "session-a")).toBe(
      takeoverState
    );
    expect(resolveCurrentTakeoverState(takeoverState, "session-b")).toBeUndefined();
    expect(resolveCurrentTakeoverState(takeoverState, undefined)).toBeUndefined();
  });

  it("shows only the final assistant timestamp for multiple assistant blocks in one turn", () => {
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
            text: "second line\n\n```mermaid\ngraph TD\n  A --> B\n```",
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

    expect(html).not.toContain("agent-codex");
    expect(html).toContain("first line");
    expect(html).toContain("second line");
    expect(html).toContain('class="awb-chat-entry__timestamp"');
    expect((html.match(/awb-chat-entry__timestamp/g) ?? []).length).toBe(1);
    expect(html).not.toContain("awb-chat-entry__meta");
    expect(html.indexOf("awb-chat-entry__timestamp")).toBeLessThan(
      html.indexOf("awb-chat-entry__messages")
    );
  });

  it("removes redundant composer chrome", () => {
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
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const html = renderToStaticMarkup(<ChatShellApp store={store} />);

    expect(html).not.toContain("Attach files");
    expect(html).not.toContain("Message the active session");
    expect(html).not.toContain("In session-1");
  });

  it("surfaces pending approvals above the composer from the active session", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-1",
            participantEngineIds: ["agent-codex"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-26T00:00:00.000Z",
            updatedAt: "2026-04-26T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "agent-codex",
            status: "awaiting_approval",
            createdAt: "2026-04-26T00:00:00.000Z",
            updatedAt: "2026-04-26T00:01:00.000Z"
          }
        ],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [
          {
            requestId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            approvalKind: "command",
            status: "pending",
            title: "Approve shell command",
            details: "echo approval",
            requestedAt: "2026-04-26T00:01:00.000Z"
          }
        ],
        participants: [],
        sessionRelations: []
      })
    );

    const html = renderToStaticMarkup(<ChatShellApp store={store} />);

    expect(html).toContain('aria-label="Pending approvals"');
    expect(html).toContain("Approve shell command");
    expect(html).toContain("echo approval");
    expect(html.indexOf("awb-composer-approvals")).toBeLessThan(
      html.indexOf("<textarea")
    );
  });
});
