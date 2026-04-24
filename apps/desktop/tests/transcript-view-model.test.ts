import { describe, expect, it } from "vitest";
import { parseDomainSnapshot } from "@another-workbench/shared";
import { selectTurnsForSession } from "../src/store/selectors.js";
import { createRendererStore } from "../src/store/store.js";
import { buildParticipantDirectory } from "../src/ui/chat-shell/participant-directory.js";
import { buildTurnTranscriptRows } from "../src/ui/chat-shell/transcript-view-model.js";

describe("transcript view model", () => {
  it("builds transcript rows with turn payloads and participant-aware turn identities", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conv-1",
            participantEngineIds: ["agent-1"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "running",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-2",
            sessionId: "session-1",
            status: "streaming",
            startedAt: "2026-04-17T00:00:02.000Z",
            messageIds: ["message-2"],
            toolCallIds: ["tool-ordered"],
            terminalIds: ["terminal-ordered"],
            approvalRequestIds: ["approval-ordered"]
          },
          {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            messageIds: ["message-1"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-1:start",
            messageId: "message-1",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-1:md",
            messageId: "message-1",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "hello",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:01.100Z"
          },
          {
            blockId: "message-2:md",
            messageId: "message-2",
            sessionId: "session-1",
            turnId: "turn-2",
            role: "assistant",
            kind: "markdown",
            text: "second turn",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:02.100Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-ordered",
            sessionId: "session-1",
            turnId: "turn-2",
            toolName: "ordered",
            status: "running",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:02.200Z"
          },
          {
            toolCallId: "tool-fallback",
            sessionId: "session-1",
            turnId: "turn-2",
            toolName: "fallback",
            status: "running",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:02.300Z"
          }
        ],
        terminalStreams: [
          {
            terminalId: "terminal-ordered",
            sessionId: "session-1",
            turnId: "turn-2",
            status: "running",
            outputText: "line 1",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:02.200Z"
          },
          {
            terminalId: "terminal-fallback",
            sessionId: "session-1",
            turnId: "turn-2",
            status: "running",
            outputText: "line 2",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            startedAt: "2026-04-17T00:00:02.250Z"
          }
        ],
        approvalRequests: [
          {
            requestId: "approval-ordered",
            sessionId: "session-1",
            turnId: "turn-2",
            approvalKind: "tool",
            status: "pending",
            title: "ordered",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            requestedAt: "2026-04-17T00:00:02.200Z"
          },
          {
            requestId: "approval-fallback",
            sessionId: "session-1",
            turnId: "turn-2",
            approvalKind: "tool",
            status: "pending",
            title: "fallback",
            actor: {
              participantId: "participant-1",
              engineId: "agent-1"
            },
            requestedAt: "2026-04-17T00:00:02.250Z"
          }
        ],
        participants: [
          {
            participantId: "participant-1",
            conversationId: "conv-1",
            engineId: "agent-1",
            role: "primary",
            capabilities: ["chat", "tool"],
            activeSessionIds: ["session-1"]
          }
        ],
        sessionRelations: []
      })
    );

    const state = store.getState();
    const turns = selectTurnsForSession(state, "session-1");
    const participantDirectory = buildParticipantDirectory(
      Object.values(state.entities.participants)
    );
    const rows = buildTurnTranscriptRows(state, turns, participantDirectory);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.turn.turnId).toBe("turn-1");
    expect(rows[1]?.turn.turnId).toBe("turn-2");
    expect(rows[0]?.defaultProcessExpanded).toBe(false);
    expect(rows[1]?.defaultProcessExpanded).toBe(true);
    expect(rows[0]?.hasProcessDetails).toBe(false);
    expect(rows[1]?.hasProcessDetails).toBe(true);

    expect(rows[0]?.turnIdentity).toMatchObject({
      label: "agent-1",
      participantId: "participant-1",
      role: "primary"
    });
    expect(rows[0]?.blocks.map((block) => block.blockId)).toEqual(["message-1:md"]);
    expect(rows[0]?.blocks[0]).toMatchObject({
      // Legacy snapshots used to include an empty `${messageId}:start` placeholder plus
      // a `${messageId}:md` markdown block. We normalize those into a single stable
      // markdown block, preserving the earlier startedAt.
      startedAt: "2026-04-17T00:00:01.000Z",
      text: "hello"
    });
    expect(rows[1]?.toolCalls.map((toolCall) => toolCall.toolCallId)).toEqual([
      "tool-ordered",
      "tool-fallback"
    ]);
    expect(rows[1]?.terminalStreams.map((stream) => stream.terminalId)).toEqual([
      "terminal-ordered",
      "terminal-fallback"
    ]);
    expect(rows[1]?.approvals.map((approval) => approval.requestId)).toEqual([
      "approval-ordered",
      "approval-fallback"
    ]);
  });

  it("splits a mixed user and assistant turn into separate transcript rows", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conv-1",
            participantEngineIds: ["agent-1"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "completed",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            messageIds: ["message-user", "message-assistant"],
            toolCallIds: ["tool-1"],
            terminalIds: ["terminal-1"],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-user:md",
            messageId: "message-user",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: "Reply with exactly hi.",
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-assistant:md",
            messageId: "message-assistant",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "hi",
            startedAt: "2026-04-17T00:00:02.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "exec",
            status: "completed",
            startedAt: "2026-04-17T00:00:02.100Z",
            completedAt: "2026-04-17T00:00:02.200Z"
          }
        ],
        terminalStreams: [
          {
            terminalId: "terminal-1",
            sessionId: "session-1",
            turnId: "turn-1",
            status: "completed",
            outputText: "done",
            startedAt: "2026-04-17T00:00:02.100Z",
            completedAt: "2026-04-17T00:00:02.200Z"
          }
        ],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const state = store.getState();
    const turns = selectTurnsForSession(state, "session-1");
    const rows = buildTurnTranscriptRows(state, turns);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.rowId)).toEqual([
      "turn-1:user:0",
      "turn-1:assistant:1"
    ]);
    expect(rows.map((row) => row.messageRole)).toEqual(["user", "assistant"]);
    expect(rows[0]?.blocks.map((block) => block.text)).toEqual([
      "Reply with exactly hi."
    ]);
    expect(rows[0]?.hasProcessDetails).toBe(false);
    expect(rows[1]?.blocks.map((block) => block.text)).toEqual(["hi"]);
    expect(rows[1]?.toolCalls.map((tool) => tool.toolCallId)).toEqual(["tool-1"]);
    expect(rows[1]?.terminalStreams.map((stream) => stream.terminalId)).toEqual([
      "terminal-1"
    ]);
  });

  it("keeps transcript rows focused on message and process content even when messages reference files", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conv-1",
            participantEngineIds: ["agent-1"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "completed",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            messageIds: ["message-user-1", "message-user-2", "message-assistant-1"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-user-1:md",
            messageId: "message-user-1",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: [
              "[Readme](file:///C:/repo/docs/README.md)",
              "![Diagram](file:///C:/repo/assets/diagram.png)"
            ].join("\n"),
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-user-2:md",
            messageId: "message-user-2",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: "Same file again: `C:\\repo\\docs\\README.md`",
            startedAt: "2026-04-17T00:00:01.500Z"
          },
          {
            blockId: "message-assistant-1:md",
            messageId: "message-assistant-1",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Follow up in `C:\\repo\\notes\\todo.txt`.",
            startedAt: "2026-04-17T00:00:02.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const state = store.getState();
    const turns = selectTurnsForSession(state, "session-1");
    const rows = buildTurnTranscriptRows(state, turns);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.messageRole).toBe("user");
    expect(rows[0]?.blocks.map((block) => block.blockId)).toEqual([
      "message-user-1:md",
      "message-user-2:md"
    ]);
    expect(rows[1]?.messageRole).toBe("assistant");
    expect(rows[1]?.blocks.map((block) => block.blockId)).toEqual([
      "message-assistant-1:md"
    ]);
  });

  it("does not require transcript rows to carry turn artifact metadata", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conv-1",
            participantEngineIds: ["agent-1"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "completed",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            finishReason: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: "2026-04-17T00:00:02.000Z",
            messageIds: ["message-1"],
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
            text: "Applied change",
            startedAt: "2026-04-17T00:00:01.100Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const rows = buildTurnTranscriptRows(
      store.getState(),
      selectTurnsForSession(store.getState(), "session-1"),
      buildParticipantDirectory([])
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageRole: "assistant",
      isFinalResponseRow: false,
      hasProcessDetails: false,
      blocks: [
        expect.objectContaining({
          blockId: "message-1:md",
          text: "Applied change"
        })
      ]
    });
  });

  it("splits completed assistant history so only the final message row carries turn.finalMessageId", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conv-1",
            participantEngineIds: ["agent-1"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "completed",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            finishReason: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: "2026-04-17T00:00:03.000Z",
            finalMessageId: "message-assistant-2",
            messageIds: [
              "message-user",
              "message-assistant-1",
              "message-assistant-2"
            ],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-user:md",
            messageId: "message-user",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: "Give me the answer.",
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-assistant-1:md",
            messageId: "message-assistant-1",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Thinking aloud.",
            startedAt: "2026-04-17T00:00:02.000Z"
          },
          {
            blockId: "message-assistant-2:md",
            messageId: "message-assistant-2",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Final answer.",
            startedAt: "2026-04-17T00:00:02.500Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const rows = buildTurnTranscriptRows(
      store.getState(),
      selectTurnsForSession(store.getState(), "session-1"),
      buildParticipantDirectory([])
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      messageRole: "user",
      isFinalResponseRow: false
    });
    expect(rows[1]).toMatchObject({
      messageRole: "assistant",
      isFinalResponseRow: false,
      blocks: [
        expect.objectContaining({
          blockId: "message-assistant-1:md",
          text: "Thinking aloud."
        })
      ]
    });
    expect(rows[2]).toMatchObject({
      messageRole: "assistant",
      isFinalResponseRow: true,
      blocks: [
        expect.objectContaining({
          blockId: "message-assistant-2:md",
          text: "Final answer."
        })
      ]
    });
  });
});
