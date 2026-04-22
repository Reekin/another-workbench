import { describe, expect, it } from "vitest";
import type { EventEnvelope, RuntimeEvent } from "@another-workbench/shared";
import { parseIngestEnvelopeAction } from "../src/store/intake.js";
import { rendererStoreReducer } from "../src/store/reducer.js";
import { selectEventStreamState, selectTurnsForSession } from "../src/store/selectors.js";
import { createInitialRendererStoreState } from "../src/store/state.js";

const toEnvelope = (
  eventId: string,
  cursor: string,
  event: RuntimeEvent
): EventEnvelope => ({
  eventId,
  cursor,
  occurredAt: "2026-04-17T00:00:00.000Z",
  event
});

const toEnvelopeAt = (
  eventId: string,
  cursor: string,
  occurredAt: string,
  event: RuntimeEvent
): EventEnvelope => ({
  eventId,
  cursor,
  occurredAt,
  event
});

describe("desktop store reducer", () => {
  it("keeps event envelope metadata for replay/reconnect", () => {
    const initial = createInitialRendererStoreState();
    const envelope = toEnvelope("evt-session-created", "1", {
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-a",
      engineId: "agent-a",
      status: "idle"
    });

    const state = rendererStoreReducer(initial, parseIngestEnvelopeAction(envelope));
    const eventStream = selectEventStreamState(state);

    expect(eventStream.lastEventId).toBe("evt-session-created");
    expect(eventStream.lastCursor).toBe("1");
    expect(eventStream.lastOccurredAt).toBe("2026-04-17T00:00:00.000Z");
    expect(eventStream.recentEventIds).toEqual(["evt-session-created"]);
    expect(eventStream.seenEventIds["evt-session-created"]).toBe(true);

    const deduped = rendererStoreReducer(state, parseIngestEnvelopeAction(envelope));
    expect(deduped.indexes.sessionIdsByConversation["conversation-a"]).toEqual([
      "session-a"
    ]);
  });

  it("maintains conversation/turn aggregate links during incremental ingestion", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-1", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "idle"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-2", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-3", "3", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "hello",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-4", "4", {
          type: "tool.started",
          sessionId: "session-a",
          turnId: "turn-a",
          toolCallId: "tool-a",
          toolName: "search",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-5", "5", {
          type: "terminal.started",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-6", "6", {
          type: "approval.requested",
          sessionId: "session-a",
          turnId: "turn-a",
          requestId: "approval-a",
          approvalKind: "tool",
          title: "Need permission",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-7", "7", {
          type: "participant.updated",
          conversationId: "conversation-a",
          participantId: "participant-a",
          engineId: "agent-a",
          role: "primary",
          capabilities: []
        })
      )
    );

    const turn = selectTurnsForSession(state, "session-a")[0];
    expect(turn.messageIds).toContain("message-a");
    expect(turn.toolCallIds).toContain("tool-a");
    expect(turn.terminalIds).toContain("terminal-a");
    expect(turn.approvalRequestIds).toContain("approval-a");
    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe("hello");

    const conversation = state.entities.conversations["conversation-a"];
    expect(conversation.sessionIds).toContain("session-a");
    expect(conversation.participantEngineIds).toContain("agent-a");
  });

  it("marks terminal streams as failed when exitCode is non-zero", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-started", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-terminal-started", "3", {
          type: "terminal.started",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-terminal-completed", "4", {
          type: "terminal.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          exitCode: 2,
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.terminalStreams["terminal-a"]).toMatchObject({
      status: "failed",
      exitCode: 2
    });
  });

  it("marks terminal streams as completed when exitCode is zero", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created-2", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-started-2", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-terminal-started-2", "3", {
          type: "terminal.started",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-terminal-completed-2", "4", {
          type: "terminal.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          exitCode: 0,
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.terminalStreams["terminal-a"]).toMatchObject({
      status: "completed",
      exitCode: 0
    });
  });

  it("disposes one session without disturbing the others", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(state, {
      type: "store/hydrateSnapshot",
      snapshot: {
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            activeSessionId: "session-a",
            sessionIds: ["session-a"]
          },
          {
            conversationId: "conversation-b",
            participantEngineIds: ["agent-b"],
            activeSessionId: "session-b",
            sessionIds: ["session-b"]
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "idle",
            createdAt: "2026-04-19T00:00:00.000Z",
            updatedAt: "2026-04-19T00:00:00.000Z"
          },
          {
            sessionId: "session-b",
            conversationId: "conversation-b",
            engineId: "agent-b",
            status: "idle",
            createdAt: "2026-04-19T00:00:01.000Z",
            updatedAt: "2026-04-19T00:00:01.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-a",
            sessionId: "session-a",
            status: "completed",
            startedAt: "2026-04-19T00:00:00.000Z",
            completedAt: "2026-04-19T00:00:02.000Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-b",
            sessionId: "session-b",
            status: "completed",
            startedAt: "2026-04-19T00:00:01.000Z",
            completedAt: "2026-04-19T00:00:03.000Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      }
    });

    state = rendererStoreReducer(state, {
      type: "store/disposeSession",
      sessionId: "session-a"
    });

    expect(state.entities.sessions["session-a"]).toBeUndefined();
    expect(state.entities.turns["turn-a"]).toBeUndefined();
    expect(state.entities.sessions["session-b"]).toBeDefined();
    expect(state.entities.turns["turn-b"]).toBeDefined();
  });

  it("reconciles message text from message.completed finalText", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created-final-text", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-started-final-text", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-message-delta-final-text", "3", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "更精确的。验证",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-message-completed-final-text", "4", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          finalText: "更精确的验证。",
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe("更精确的验证。");
  });

  it("persists session relations from live session.created events", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-parent", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-parent",
          engineId: "agent-a",
          status: "idle"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-child", "2", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-child",
          engineId: "agent-a",
          status: "idle",
          relation: {
            relationId: "relation-a",
            parentSessionId: "session-parent",
            childSessionId: "session-child",
            relationType: "fork",
            createdAt: "2026-04-17T00:00:02.000Z"
          }
        })
      )
    );

    expect(state.entities.sessionRelations["relation-a"]).toMatchObject({
      parentSessionId: "session-parent",
      childSessionId: "session-child",
      relationType: "fork"
    });
    expect(state.indexes.relationIdsByParentSession["session-parent"]).toEqual([
      "relation-a"
    ]);
    expect(state.indexes.relationIdsByChildSession["session-child"]).toEqual([
      "relation-a"
    ]);
  });

  it("removes disposed session artifacts and repairs active selection", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-parent", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-parent",
          engineId: "agent-a",
          status: "idle"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-child", "2", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-child",
          engineId: "agent-a",
          status: "idle",
          relation: {
            relationId: "relation-a",
            parentSessionId: "session-parent",
            childSessionId: "session-child",
            relationType: "fork",
            createdAt: "2026-04-17T00:00:02.000Z"
          }
        })
      )
    );
    state = rendererStoreReducer(state, {
      type: "store/setActiveConversation",
      conversationId: "conversation-a"
    });
    state = rendererStoreReducer(state, {
      type: "store/setActiveSession",
      sessionId: "session-parent"
    });
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-started", "3", {
          type: "turn.started",
          sessionId: "session-parent",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-message-delta", "4", {
          type: "message.delta",
          sessionId: "session-parent",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "hello",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-disposed", "5", {
          type: "session.disposed",
          conversationId: "conversation-a",
          sessionId: "session-parent",
          disposedAt: "2026-04-17T00:00:05.000Z"
        })
      )
    );

    expect(state.entities.sessions["session-parent"]).toBeUndefined();
    expect(state.entities.turns["turn-a"]).toBeUndefined();
    expect(state.entities.messageBlocks["message-a:md"]).toBeUndefined();
    expect(state.entities.sessionRelations["relation-a"]).toBeUndefined();
    expect(state.entities.conversations["conversation-a"]?.sessionIds).toEqual([
      "session-child"
    ]);
    expect(state.entities.conversations["conversation-a"]?.activeSessionId).toBe(
      "session-child"
    );
    expect(state.activeConversationId).toBe("conversation-a");
    expect(state.activeSessionId).toBe("session-child");
  });

  it("preserves occurredAt timestamps and buffered tool or terminal output when started arrives later", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-session", "1", "2026-04-17T00:00:01.000Z", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-message-delta", "2", "2026-04-17T00:00:02.000Z", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "hello",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-tool-delta", "3", "2026-04-17T00:00:03.000Z", {
          type: "tool.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          toolCallId: "tool-a",
          delta: "partial",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-terminal-output", "4", "2026-04-17T00:00:04.000Z", {
          type: "terminal.output",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          chunk: "line-1\n",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-message-started", "5", "2026-04-17T00:00:05.000Z", {
          type: "message.started",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          role: "assistant",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-tool-started", "6", "2026-04-17T00:00:06.000Z", {
          type: "tool.started",
          sessionId: "session-a",
          turnId: "turn-a",
          toolCallId: "tool-a",
          toolName: "search",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-terminal-started", "7", "2026-04-17T00:00:07.000Z", {
          type: "terminal.started",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          toolCallId: "tool-a",
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.messageBlocks["message-a:md"]).toMatchObject({
      text: "hello",
      startedAt: "2026-04-17T00:00:02.000Z"
    });
    expect(state.entities.toolCalls["tool-a"]).toMatchObject({
      toolName: "search",
      outputSummary: "partial",
      startedAt: "2026-04-17T00:00:03.000Z"
    });
    expect(state.entities.terminalStreams["terminal-a"]).toMatchObject({
      toolCallId: "tool-a",
      outputText: "line-1\n",
      startedAt: "2026-04-17T00:00:04.000Z"
    });
  });

  it("caps seen event ids to a bounded replay dedupe window", () => {
    let state = createInitialRendererStoreState();

    for (let index = 1; index <= 2050; index += 1) {
      state = rendererStoreReducer(
        state,
        parseIngestEnvelopeAction(
          toEnvelopeAt(
            `evt-${index}`,
            String(index),
            `2026-04-17T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
            {
              type: "runtime.error",
              code: `E${index}`,
              message: `error-${index}`,
              recoverable: true
            }
          )
        )
      );
    }

    expect(state.eventStream.recentEventIds).toHaveLength(2048);
    expect(state.eventStream.recentEventIds[0]).toBe("evt-3");
    expect(state.eventStream.recentEventIds.at(-1)).toBe("evt-2050");
    expect(state.eventStream.seenEventIds["evt-1"]).toBeUndefined();
    expect(state.eventStream.seenEventIds["evt-2"]).toBeUndefined();
    expect(state.eventStream.seenEventIds["evt-2050"]).toBe(true);
  });

  it("disposes a session by pruning session-scoped entities and rebuilding indexes only", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(state, {
      type: "store/hydrateSnapshot",
      snapshot: {
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            sessionIds: ["session-a"],
            activeSessionId: "session-a",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          },
          {
            conversationId: "conversation-b",
            participantEngineIds: ["agent-b"],
            sessionIds: ["session-b"],
            activeSessionId: "session-b",
            createdAt: "2026-04-17T00:01:00.000Z",
            updatedAt: "2026-04-17T00:01:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "completed",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:02.000Z"
          },
          {
            sessionId: "session-b",
            conversationId: "conversation-b",
            engineId: "agent-b",
            status: "idle",
            createdAt: "2026-04-17T00:01:00.000Z",
            updatedAt: "2026-04-17T00:01:02.000Z"
          }
        ],
        turns: [
          {
            turnId: "turn-a",
            sessionId: "session-a",
            status: "completed",
            startedAt: "2026-04-17T00:00:00.000Z",
            completedAt: "2026-04-17T00:00:02.000Z",
            messageIds: ["message-a"],
            toolCallIds: ["tool-a"],
            terminalIds: ["terminal-a"],
            approvalRequestIds: ["approval-a"]
          },
          {
            turnId: "turn-b",
            sessionId: "session-b",
            status: "completed",
            startedAt: "2026-04-17T00:01:00.000Z",
            completedAt: "2026-04-17T00:01:02.000Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-a:md",
            messageId: "message-a",
            sessionId: "session-a",
            turnId: "turn-a",
            role: "assistant",
            kind: "markdown",
            text: "hello",
            startedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-a",
            sessionId: "session-a",
            turnId: "turn-a",
            toolName: "search",
            status: "completed",
            startedAt: "2026-04-17T00:00:00.000Z",
            completedAt: "2026-04-17T00:00:01.000Z"
          }
        ],
        terminalStreams: [
          {
            terminalId: "terminal-a",
            sessionId: "session-a",
            turnId: "turn-a",
            status: "completed",
            outputText: "ok",
            startedAt: "2026-04-17T00:00:00.000Z",
            completedAt: "2026-04-17T00:00:01.000Z"
          }
        ],
        approvalRequests: [
          {
            requestId: "approval-a",
            sessionId: "session-a",
            turnId: "turn-a",
            approvalKind: "tool",
            status: "approved",
            title: "Need approval",
            requestedAt: "2026-04-17T00:00:00.000Z"
          }
        ],
        participants: [
          {
            participantId: "participant-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            activeSessionIds: ["session-a"],
            joinedAt: "2026-04-17T00:00:00.000Z"
          },
          {
            participantId: "participant-b",
            conversationId: "conversation-b",
            engineId: "agent-b",
            activeSessionIds: ["session-b"],
            joinedAt: "2026-04-17T00:01:00.000Z"
          }
        ],
        sessionRelations: []
      }
    });

    state = rendererStoreReducer(state, {
      type: "store/disposeSession",
      sessionId: "session-a"
    });

    expect(state.entities.sessions["session-a"]).toBeUndefined();
    expect(state.entities.turns["turn-a"]).toBeUndefined();
    expect(state.entities.messageBlocks["message-a:md"]).toBeUndefined();
    expect(state.entities.toolCalls["tool-a"]).toBeUndefined();
    expect(state.entities.terminalStreams["terminal-a"]).toBeUndefined();
    expect(state.entities.approvalRequests["approval-a"]).toBeUndefined();
    expect(state.entities.conversations["conversation-a"]).toBeUndefined();
    expect(state.entities.participants["participant-a"]).toBeUndefined();
    expect(state.indexes.turnIdsBySession["session-a"]).toBeUndefined();
    expect(state.indexes.sessionIdsByConversation["conversation-a"]).toBeUndefined();
    expect(state.activeSessionId).toBe("session-b");
    expect(state.entities.sessions["session-b"]).toBeDefined();
    expect(state.entities.turns["turn-b"]).toBeDefined();
  });
});
