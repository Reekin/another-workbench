import { describe, expect, it } from "vitest";
import { parseDomainSnapshot } from "@another-workbench/shared";
import { selectTurnsForSession } from "../src/store/selectors.js";
import { createRendererStore } from "../src/store/store.js";
import { createInitialRendererStoreState, withDomainSnapshot } from "../src/store/state.js";
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

    const domain = store.getDomainReadModel();
    const turns = domain.listTurns({ sessionId: "session-1" });
    const participantDirectory = buildParticipantDirectory(
      domain.listParticipants({ conversationId: "conv-1" })
    );
    const rows = buildTurnTranscriptRows(domain, turns, participantDirectory);

    expect(rows).toHaveLength(8);
    expect(rows[0]?.turn.turnId).toBe("turn-1");
    expect(rows[1]?.turn.turnId).toBe("turn-2");
    expect(rows[0]?.defaultProcessExpanded).toBe(false);
    expect(rows[1]?.defaultProcessExpanded).toBe(false);
    expect(rows[0]?.hasProcessDetails).toBe(false);
    expect(rows[1]?.hasProcessDetails).toBe(false);

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
    expect(rows[1]).toMatchObject({
      rowKind: "message",
      blocks: [expect.objectContaining({ blockId: "message-2:md" })]
    });
    expect(rows.slice(2).map((row) => row.rowKind)).toEqual([
      "process",
      "process",
      "process",
      "process",
      "process",
      "process"
    ]);
    expect(rows.slice(2).map((row) => row.defaultProcessExpanded)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true
    ]);
    expect(rows.slice(2).map((row) => row.hasProcessDetails)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true
    ]);
    expect(
      rows.slice(2).map((row) => row.approvals.map((approval) => approval.requestId))
    ).toEqual([["approval-ordered"], [], [], ["approval-fallback"], [], []]);
    expect(
      rows.slice(2).map((row) => row.toolCalls.map((toolCall) => toolCall.toolCallId))
    ).toEqual([[], [], ["tool-ordered"], [], [], ["tool-fallback"]]);
    expect(
      rows.slice(2).map((row) => row.terminalStreams.map((stream) => stream.terminalId))
    ).toEqual([[], ["terminal-ordered"], [], [], ["terminal-fallback"], []]);
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

    const domain = store.getDomainReadModel();
    const turns = domain.listTurns({ sessionId: "session-1" });
    const rows = buildTurnTranscriptRows(domain, turns);

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

  it("interleaves running process rows with assistant messages by start time", () => {
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
            turnId: "turn-1",
            sessionId: "session-1",
            status: "streaming",
            startedAt: "2026-04-17T00:00:01.000Z",
            messageIds: ["message-commentary", "message-final"],
            toolCallIds: ["tool-search"],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-commentary:md",
            messageId: "message-commentary",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "I will look this up.",
            startedAt: "2026-04-17T00:00:02.000Z"
          },
          {
            blockId: "message-final:md",
            messageId: "message-final",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Here is the answer.",
            startedAt: "2026-04-17T00:00:04.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-search",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "webSearch",
            status: "completed",
            inputSummary: "Search\nquery: mini PC",
            outputSummary: "Search complete",
            startedAt: "2026-04-17T00:00:03.000Z",
            completedAt: "2026-04-17T00:00:03.500Z"
          }
        ],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const rows = buildTurnTranscriptRows(
      store.getDomainReadModel(),
      store.getDomainReadModel().listTurns({ sessionId: "session-1" }),
      buildParticipantDirectory([])
    );

    expect(rows.map((row) => row.rowKind)).toEqual(["message", "process", "message"]);
    expect(rows.map((row) => row.rowId)).toEqual([
      "turn-1:assistant:0",
      "turn-1:process:1:tool:tool-search",
      "turn-1:assistant:1"
    ]);
    expect(rows[0]?.blocks.map((block) => block.text)).toEqual([
      "I will look this up."
    ]);
    expect(rows[1]?.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
      "webSearch"
    ]);
    expect(rows[2]?.blocks.map((block) => block.text)).toEqual([
      "Here is the answer."
    ]);
  });

  it("keeps a running turn user prompt before process rows even when process timestamps are earlier", () => {
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
            turnId: "turn-1",
            sessionId: "session-1",
            status: "streaming",
            startedAt: "2026-04-17T00:00:00.000Z",
            messageIds: ["message-user", "message-assistant"],
            toolCallIds: ["tool-early"],
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
            text: "Please inspect the scene.",
            startedAt: "2026-04-17T00:00:02.000Z"
          },
          {
            blockId: "message-assistant:md",
            messageId: "message-assistant",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "I checked it.",
            startedAt: "2026-04-17T00:00:03.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-early",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "view_image",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: "2026-04-17T00:00:01.500Z"
          }
        ],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const rows = buildTurnTranscriptRows(
      store.getDomainReadModel(),
      store.getDomainReadModel().listTurns({ sessionId: "session-1" }),
      buildParticipantDirectory([])
    );

    expect(rows.map((row) => row.rowKind)).toEqual(["message", "process", "message"]);
    expect(rows.map((row) => row.messageRole)).toEqual([
      "user",
      "assistant",
      "assistant"
    ]);
    expect(rows[0]?.blocks.map((block) => block.text)).toEqual([
      "Please inspect the scene."
    ]);
    expect(rows[1]?.toolCalls.map((toolCall) => toolCall.toolCallId)).toEqual([
      "tool-early"
    ]);
  });

  it("orders user input sent during a running turn by its own timestamp", () => {
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
            turnId: "turn-1",
            sessionId: "session-1",
            status: "streaming",
            startedAt: "2026-04-17T00:00:00.000Z",
            messageIds: [
              "message-initial-user",
              "message-commentary",
              "message-later-user",
              "message-response"
            ],
            toolCallIds: ["tool-between"],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-initial-user:md",
            messageId: "message-initial-user",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: "Start the task.",
            startedAt: "2026-04-17T00:00:02.000Z"
          },
          {
            blockId: "message-commentary:md",
            messageId: "message-commentary",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Working on it.",
            startedAt: "2026-04-17T00:00:03.000Z"
          },
          {
            blockId: "message-later-user:md",
            messageId: "message-later-user",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: "Also check the logs.",
            startedAt: "2026-04-17T00:00:05.000Z"
          },
          {
            blockId: "message-response:md",
            messageId: "message-response",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Checking those now.",
            startedAt: "2026-04-17T00:00:06.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-between",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "exec",
            status: "completed",
            startedAt: "2026-04-17T00:00:04.000Z",
            completedAt: "2026-04-17T00:00:04.500Z"
          }
        ],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const domain = store.getDomainReadModel();
    const rows = buildTurnTranscriptRows(
      domain,
      domain.listTurns({ sessionId: "session-1" }),
      buildParticipantDirectory([])
    );

    expect(
      rows.map((item) =>
        item.rowKind === "message"
          ? item.blocks[0]?.messageId
          : item.toolCalls[0]?.toolCallId
      )
    ).toEqual([
      "message-initial-user",
      "message-commentary",
      "tool-between",
      "message-later-user",
      "message-response"
    ]);
  });

  it("respects turn message order over message block timestamps", () => {
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
            startedAt: "2026-04-17T00:00:00.000Z",
            completedAt: "2026-04-17T00:00:04.000Z",
            finalMessageId: "message-assistant",
            messageIds: ["message-user", "message-assistant"],
            toolCallIds: ["tool-after-user"],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-assistant:md",
            messageId: "message-assistant",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Tool finished.",
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-user:md",
            messageId: "message-user",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "user",
            kind: "markdown",
            text: "Run the inspection.",
            startedAt: "2026-04-17T00:00:02.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-after-user",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "shell",
            status: "completed",
            startedAt: "2026-04-17T00:00:03.000Z",
            completedAt: "2026-04-17T00:00:03.500Z"
          }
        ],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const rows = buildTurnTranscriptRows(
      store.getDomainReadModel(),
      store.getDomainReadModel().listTurns({ sessionId: "session-1" }),
      buildParticipantDirectory([])
    );

    expect(rows.map((row) => row.messageRole)).toEqual(["user", "assistant"]);
    expect(rows[0]?.blocks.map((block) => block.text)).toEqual([
      "Run the inspection."
    ]);
    expect(rows[1]?.blocks.map((block) => block.text)).toEqual(["Tool finished."]);
    expect(rows[1]?.toolCalls.map((toolCall) => toolCall.toolCallId)).toEqual([
      "tool-after-user"
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

    const domain = store.getDomainReadModel();
    const turns = domain.listTurns({ sessionId: "session-1" });
    const rows = buildTurnTranscriptRows(domain, turns);

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
      store.getDomainReadModel(),
      store.getDomainReadModel().listTurns({ sessionId: "session-1" }),
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
      store.getDomainReadModel(),
      store.getDomainReadModel().listTurns({ sessionId: "session-1" }),
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
      canDisplayAsFinalResponse: true,
      blocks: [
        expect.objectContaining({
          blockId: "message-assistant-2:md",
          text: "Final answer."
        })
      ]
    });
  });

  it("keeps phase-aware commentary out of the final response candidate", () => {
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
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            finishReason: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: "2026-04-17T00:00:03.000Z",
            messageIds: ["message-user", "message-commentary"],
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
            text: "Please do the work.",
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-commentary:md",
            messageId: "message-commentary",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            phase: "commentary",
            kind: "markdown",
            text: "I will inspect the code first.",
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

    const rows = buildTurnTranscriptRows(
      store.getDomainReadModel(),
      store.getDomainReadModel().listTurns({ sessionId: "session-1" }),
      buildParticipantDirectory([])
    );

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      messageRole: "assistant",
      canDisplayAsFinalResponse: false,
      blocks: [
        expect.objectContaining({
          phase: "commentary",
          text: "I will inspect the code first."
        })
      ]
    });
    expect(rows[2]).toMatchObject({
      rowId: "turn-1:assistant:pending-final",
      messageRole: "assistant",
      canDisplayAsFinalResponse: true,
      blocks: []
    });
  });

  it("builds the visible session transcript without touching unindexed background entities", () => {
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
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
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
            text: "Visible response.",
            startedAt: "2026-04-17T00:00:01.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const state = withDomainSnapshot(
      createInitialRendererStoreState(),
      store.getDomainReadModel().getSnapshot()
    );
    const withPoisonedBackgroundEntity = <T extends object>(items: T, key: string): T => {
      const next = { ...items };
      Object.defineProperty(next, key, {
        enumerable: true,
        get() {
          throw new Error(`background entity scanned: ${key}`);
        }
      });
      return next;
    };
    const stateWithBackgroundPoison = {
      ...state,
      entities: {
        ...state.entities,
        messageBlocks: withPoisonedBackgroundEntity(
          state.entities.messageBlocks,
          "background-message:md"
        ),
        toolCalls: withPoisonedBackgroundEntity(
          state.entities.toolCalls,
          "background-tool"
        ),
        terminalStreams: withPoisonedBackgroundEntity(
          state.entities.terminalStreams,
          "background-terminal"
        ),
        approvalRequests: withPoisonedBackgroundEntity(
          state.entities.approvalRequests,
          "background-approval"
        ),
        runtimeInteractions: withPoisonedBackgroundEntity(
          state.entities.runtimeInteractions,
          "background-interaction"
        )
      }
    };

    const rows = buildTurnTranscriptRows(
      stateWithBackgroundPoison,
      selectTurnsForSession(state, "session-1"),
      buildParticipantDirectory([])
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocks).toEqual([
      expect.objectContaining({
        blockId: "message-1:md",
        text: "Visible response."
      })
    ]);
  });

  it("ignores stale by-turn index entries whose entity owner changed", () => {
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
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            messageIds: ["message-visible"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-visible:md",
            messageId: "message-visible",
            sessionId: "session-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "markdown",
            text: "Visible response.",
            startedAt: "2026-04-17T00:00:01.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      })
    );

    const state = withDomainSnapshot(
      createInitialRendererStoreState(),
      store.getDomainReadModel().getSnapshot()
    );
    const stateWithStaleIndex = {
      ...state,
      entities: {
        ...state.entities,
        messageBlocks: {
          ...state.entities.messageBlocks,
          "message-stale:md": {
            blockId: "message-stale:md",
            messageId: "message-stale",
            sessionId: "session-1",
            turnId: "turn-old",
            role: "assistant" as const,
            kind: "markdown" as const,
            text: "Stale response.",
            startedAt: "2026-04-17T00:00:00.000Z"
          }
        }
      },
      indexes: {
        ...state.indexes,
        messageBlockIdsByTurn: {
          ...state.indexes.messageBlockIdsByTurn,
          "turn-1": [
            ...(state.indexes.messageBlockIdsByTurn["turn-1"] ?? []),
            "message-stale:md"
          ]
        }
      }
    };

    const rows = buildTurnTranscriptRows(
      stateWithStaleIndex,
      selectTurnsForSession(state, "session-1"),
      buildParticipantDirectory([])
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocks.map((block) => block.blockId)).toEqual([
      "message-visible:md"
    ]);
  });

  it("ignores stale direct turn references whose entity owner changed", () => {
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
            turnId: "turn-old",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            messageIds: ["message-moved"],
            toolCallIds: ["tool-moved"],
            terminalIds: ["terminal-moved"],
            approvalRequestIds: ["approval-moved"],
            interactionRequestIds: ["interaction-moved"]
          },
          {
            turnId: "turn-new",
            sessionId: "session-1",
            status: "completed",
            startedAt: "2026-04-17T00:00:02.000Z",
            messageIds: ["message-moved"],
            toolCallIds: ["tool-moved"],
            terminalIds: ["terminal-moved"],
            approvalRequestIds: ["approval-moved"],
            interactionRequestIds: ["interaction-moved"]
          }
        ],
        messageBlocks: [
          {
            blockId: "message-moved:md",
            messageId: "message-moved",
            sessionId: "session-1",
            turnId: "turn-new",
            role: "assistant",
            kind: "markdown",
            text: "Moved response.",
            startedAt: "2026-04-17T00:00:02.100Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-moved",
            sessionId: "session-1",
            turnId: "turn-new",
            toolName: "exec",
            status: "completed",
            startedAt: "2026-04-17T00:00:02.200Z"
          }
        ],
        terminalStreams: [
          {
            terminalId: "terminal-moved",
            sessionId: "session-1",
            turnId: "turn-new",
            status: "completed",
            outputText: "output",
            startedAt: "2026-04-17T00:00:02.300Z"
          }
        ],
        approvalRequests: [
          {
            requestId: "approval-moved",
            sessionId: "session-1",
            turnId: "turn-new",
            approvalKind: "tool",
            status: "pending",
            title: "Approve command",
            requestedAt: "2026-04-17T00:00:02.400Z"
          }
        ],
        runtimeInteractions: [
          {
            requestId: "interaction-moved",
            sessionId: "session-1",
            turnId: "turn-new",
            interactionKind: "tool_user_input",
            status: "pending",
            title: "Provide input",
            payload: {},
            requestedAt: "2026-04-17T00:00:02.500Z"
          }
        ],
        participants: [],
        sessionRelations: []
      })
    );

    const state = withDomainSnapshot(
      createInitialRendererStoreState(),
      store.getDomainReadModel().getSnapshot()
    );
    const oldTurn = state.entities.turns["turn-old"];
    const newTurn = state.entities.turns["turn-new"];
    expect(oldTurn).toBeDefined();
    expect(newTurn).toBeDefined();

    const oldRows = buildTurnTranscriptRows(
      state,
      oldTurn ? [oldTurn] : [],
      buildParticipantDirectory([])
    );
    const newRows = buildTurnTranscriptRows(
      state,
      newTurn ? [newTurn] : [],
      buildParticipantDirectory([])
    );

    expect(oldRows.flatMap((row) => row.blocks)).toEqual([]);
    expect(oldRows.flatMap((row) => row.toolCalls)).toEqual([]);
    expect(oldRows.flatMap((row) => row.terminalStreams)).toEqual([]);
    expect(oldRows.flatMap((row) => row.approvals)).toEqual([]);
    expect(oldRows.flatMap((row) => row.interactions)).toEqual([]);
    expect(newRows.flatMap((row) => row.blocks).map((block) => block.blockId)).toEqual([
      "message-moved:md"
    ]);
    expect(
      newRows.flatMap((row) => row.toolCalls).map((tool) => tool.toolCallId)
    ).toEqual(["tool-moved"]);
    expect(
      newRows.flatMap((row) => row.terminalStreams).map((stream) => stream.terminalId)
    ).toEqual(["terminal-moved"]);
    expect(
      newRows.flatMap((row) => row.approvals).map((approval) => approval.requestId)
    ).toEqual(["approval-moved"]);
    expect(
      newRows.flatMap((row) => row.interactions).map((interaction) => interaction.requestId)
    ).toEqual(["interaction-moved"]);
  });
});
