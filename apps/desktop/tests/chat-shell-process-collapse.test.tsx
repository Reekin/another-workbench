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
import { TurnProcessPanel } from "../src/ui/chat-shell/TurnProcessPanel.js";
import { buildParticipantDirectory } from "../src/ui/chat-shell/participant-directory.js";
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

  it("keeps completed turn history collapsed while leaving running turn process open", () => {
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
            completedAt: "2026-04-18T00:01:20.000Z",
            finalMessageId: "message-completed-final",
            startedAt: "2026-04-18T00:01:00.000Z",
            messageIds: [
              "message-completed-user",
              "message-completed-thinking",
              "message-completed-final"
            ],
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
            blockId: "message-completed-user:md",
            messageId: "message-completed-user",
            sessionId: "session-1",
            turnId: "turn-completed",
            role: "user",
            kind: "markdown",
            text: "Please summarize.",
            startedAt: "2026-04-18T00:01:00.500Z"
          },
          {
            blockId: "message-completed-thinking:md",
            messageId: "message-completed-thinking",
            sessionId: "session-1",
            turnId: "turn-completed",
            role: "assistant",
            kind: "markdown",
            text: "internal draft",
            startedAt: "2026-04-18T00:01:01.000Z"
          },
          {
            blockId: "message-completed-final:md",
            messageId: "message-completed-final",
            sessionId: "session-1",
            turnId: "turn-completed",
            role: "assistant",
            kind: "markdown",
            text: "completed final",
            startedAt: "2026-04-18T00:01:05.000Z"
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
    expect(html).toContain("1 previous message &gt;");
    expect(html).not.toContain("Hide process output");
    expect(html).not.toContain("Show turn details");
    expect(html).not.toContain("1 earlier message");
    expect(html).not.toContain("<h4>Activity</h4>");
    expect(html).toContain('class="awb-turn__process awb-turn__process--history"');
    expect((html.match(/awb-chat-entry__timestamp/g) ?? []).length).toBe(2);
    expect(html).toContain("completed final");
    expect(html).toContain("Please summarize.");
    expect(html).not.toContain("internal draft");
    expect(html).toContain("is-followed-by-same-turn");
    expect(html.indexOf("1 previous message &gt;")).toBeLessThan(
      html.indexOf("completed final")
    );
    expect(html.indexOf("running turn")).toBeLessThan(
      html.indexOf("grep")
    );
  });

  it("interleaves message-level history and process records by time", () => {
    const row = {
      rowId: "turn-1:assistant:final",
      rowKind: "message" as const,
      startedAt: "2026-04-18T00:01:05.000Z",
      turn: {
        turnId: "turn-1",
        sessionId: "session-1",
        status: "completed" as const,
        startedAt: "2026-04-18T00:01:00.000Z",
        completedAt: "2026-04-18T00:01:20.000Z",
        messageIds: [],
        toolCallIds: ["tool-1"],
        terminalIds: ["terminal-1"],
        approvalRequestIds: []
      },
      turnIdentity: {
        label: "assistant",
        kind: "turn" as const
      },
      messageRole: "assistant" as const,
      isFinalResponseRow: true,
      canDisplayAsFinalResponse: true,
      blocks: [],
      toolCalls: [
        {
          toolCallId: "tool-1",
          sessionId: "session-1",
          turnId: "turn-1",
          toolName: "commandExecution",
          status: "completed" as const,
          inputSummary: "pwd",
          startedAt: "2026-04-18T00:01:02.000Z",
          completedAt: "2026-04-18T00:01:03.000Z"
        }
      ],
      terminalStreams: [
        {
          terminalId: "terminal-1",
          sessionId: "session-1",
          turnId: "turn-1",
          toolCallId: "tool-1",
          status: "completed" as const,
          outputText: "$ pwd\n/I/project\n",
          exitCode: 0,
          startedAt: "2026-04-18T00:01:02.000Z",
          completedAt: "2026-04-18T00:01:03.000Z"
        }
      ],
      approvals: [],
      interactions: [],
      hasProcessDetails: true,
      defaultProcessExpanded: false
    };
    const hiddenRows = [
      {
        ...row,
        rowId: "turn-1:assistant:history",
        startedAt: "2026-04-18T00:01:01.000Z",
        isFinalResponseRow: false,
        canDisplayAsFinalResponse: false,
        blocks: [
          {
            blockId: "draft:md",
            messageId: "draft",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "internal draft",
            startedAt: "2026-04-18T00:01:01.000Z"
          },
          {
            blockId: "note:md",
            messageId: "note",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "after tool note",
            startedAt: "2026-04-18T00:01:04.000Z"
          },
          {
            blockId: "note:continuation",
            messageId: "note",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "same message continuation",
            startedAt: "2026-04-18T00:01:04.500Z"
          }
        ],
        toolCalls: [],
        terminalStreams: []
      }
    ];

    const html = renderToStaticMarkup(
      <TurnProcessPanel
        row={row}
        hiddenRows={hiddenRows}
        participantDirectory={buildParticipantDirectory([])}
        onActivateResourceLink={() => undefined}
      />
    );

    expect(html).toContain("Earlier in this turn");
    expect(html).not.toContain("<h4>Activity</h4>");
    expect(html).not.toContain("awb-turn-process__history-entry");
    expect(html.indexOf("internal draft")).toBeLessThan(html.indexOf("Shell pwd"));
    expect(html.indexOf("Shell pwd")).toBeLessThan(html.indexOf("after tool note"));
    expect(html.indexOf("after tool note")).toBeLessThan(
      html.indexOf("same message continuation")
    );
  });

  it("interleaves approvals and interactions without duplicating them", () => {
    const row = {
      rowId: "turn-2:assistant:final",
      rowKind: "message" as const,
      startedAt: "2026-04-18T00:02:08.000Z",
      turn: {
        turnId: "turn-2",
        sessionId: "session-1",
        status: "completed" as const,
        startedAt: "2026-04-18T00:02:00.000Z",
        completedAt: "2026-04-18T00:02:10.000Z",
        messageIds: [],
        toolCallIds: [],
        terminalIds: [],
        approvalRequestIds: ["approval-1"]
      },
      turnIdentity: { label: "assistant", kind: "turn" as const },
      messageRole: "assistant" as const,
      isFinalResponseRow: true,
      canDisplayAsFinalResponse: true,
      blocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvals: [
        {
          requestId: "approval-1",
          sessionId: "session-1",
          turnId: "turn-2",
          approvalKind: "command_execution" as const,
          status: "approved" as const,
          title: "Approve command",
          availableActions: [],
          requestedAt: "2026-04-18T00:02:02.000Z"
        }
      ],
      interactions: [
        {
          requestId: "interaction-1",
          sessionId: "session-1",
          turnId: "turn-2",
          interactionKind: "tool_user_input" as const,
          status: "completed" as const,
          title: "Choose target",
          payload: { questions: [] },
          requestedAt: "2026-04-18T00:02:04.000Z"
        }
      ],
      hasProcessDetails: true,
      defaultProcessExpanded: false
    };
    const hiddenRows = [
      {
        ...row,
        rowId: "turn-2:assistant:history",
        startedAt: "2026-04-18T00:02:01.000Z",
        isFinalResponseRow: false,
        canDisplayAsFinalResponse: false,
        blocks: [
          {
            blockId: "before:md",
            messageId: "before",
            sessionId: "session-1",
            turnId: "turn-2",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "before approval",
            startedAt: "2026-04-18T00:02:01.000Z"
          },
          {
            blockId: "between:md",
            messageId: "between",
            sessionId: "session-1",
            turnId: "turn-2",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "between requests",
            startedAt: "2026-04-18T00:02:03.000Z"
          },
          {
            blockId: "after:md",
            messageId: "after",
            sessionId: "session-1",
            turnId: "turn-2",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "after interaction",
            startedAt: "2026-04-18T00:02:05.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvals: [],
        interactions: []
      }
    ];

    const html = renderToStaticMarkup(
      <TurnProcessPanel
        row={row}
        hiddenRows={hiddenRows}
        participantDirectory={buildParticipantDirectory([])}
        onActivateResourceLink={() => undefined}
      />
    );

    expect(html.indexOf("before approval")).toBeLessThan(html.indexOf("Approve command"));
    expect(html.indexOf("Approve command")).toBeLessThan(html.indexOf("between requests"));
    expect(html.indexOf("between requests")).toBeLessThan(html.indexOf("Choose target"));
    expect(html.indexOf("Choose target")).toBeLessThan(html.indexOf("after interaction"));
    expect((html.match(/Approve command/g) ?? []).length).toBe(1);
    expect((html.match(/Choose target/g) ?? []).length).toBe(1);
  });
});
