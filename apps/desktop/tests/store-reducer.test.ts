import { describe, expect, it } from "vitest";
import type {
  DomainSnapshot,
  EventEnvelope,
  RuntimeEvent
} from "@another-workbench/shared";
import { MAX_ACCUMULATED_STREAM_TEXT_LENGTH } from "@another-workbench/shared";
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

  it("uses hydrated session window cursors as barriers for stale stream envelopes", () => {
    const snapshot: DomainSnapshot = {
      conversations: [
        {
          conversationId: "conversation-a",
          sessionIds: ["session-a"],
          participantEngineIds: ["agent-a"],
          activeSessionId: "session-a",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-a",
          conversationId: "conversation-a",
          engineId: "agent-a",
          status: "running",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z",
          lastTurnId: "turn-a"
        }
      ],
      turns: [
        {
          turnId: "turn-a",
          sessionId: "session-a",
          status: "running",
          messageIds: ["message-a"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: [],
          startedAt: "2026-04-17T00:00:00.000Z"
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
          text: "latest text",
          startedAt: "2026-04-17T00:00:00.000Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      sessionRelations: []
    };

    let state = rendererStoreReducer(createInitialRendererStoreState(), {
      type: "store/hydrateSessionWindow",
      sessionId: "session-a",
      snapshot,
      mode: "replace",
      cursor: "cursor-10"
    });

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-stale-delta", "cursor-9", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: " stale"
        })
      )
    );

    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe("latest text");
    expect(state.eventStream.lastCursor).toBeUndefined();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-other-session", "cursor-9", {
          type: "turn.started",
          sessionId: "session-b",
          turnId: "turn-b"
        })
      )
    );

    expect(state.entities.turns["turn-b"]?.sessionId).toBe("session-b");
    expect(state.eventStream.lastCursor).toBe("cursor-9");

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-covered-delta", "cursor-10", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: " covered"
        })
      )
    );

    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe("latest text");
    expect(state.eventStream.lastCursor).toBe("cursor-9");

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-live-delta", "cursor-11", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: " live"
        })
      )
    );

    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe(
      "latest text live"
    );
    expect(state.eventStream.lastCursor).toBe("cursor-11");
  });

  it("does not use prepend session window cursors as barriers for queued live events", () => {
    const currentSnapshot: DomainSnapshot = {
      conversations: [
        {
          conversationId: "conversation-a",
          sessionIds: ["session-a"],
          participantEngineIds: ["agent-a"],
          activeSessionId: "session-a",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-a",
          conversationId: "conversation-a",
          engineId: "agent-a",
          status: "running",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z",
          lastTurnId: "turn-current"
        }
      ],
      turns: [
        {
          turnId: "turn-current",
          sessionId: "session-a",
          status: "running",
          messageIds: ["message-current"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: [],
          startedAt: "2026-04-17T00:00:10.000Z"
        }
      ],
      messageBlocks: [
        {
          blockId: "message-current:md",
          messageId: "message-current",
          sessionId: "session-a",
          turnId: "turn-current",
          role: "assistant",
          kind: "markdown",
          text: "current text",
          startedAt: "2026-04-17T00:00:10.000Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      sessionRelations: []
    };
    const olderSnapshot: DomainSnapshot = {
      conversations: currentSnapshot.conversations,
      sessions: currentSnapshot.sessions,
      turns: [
        {
          turnId: "turn-older",
          sessionId: "session-a",
          status: "completed",
          messageIds: ["message-older"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: [],
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z",
          finishReason: "completed"
        }
      ],
      messageBlocks: [
        {
          blockId: "message-older:md",
          messageId: "message-older",
          sessionId: "session-a",
          turnId: "turn-older",
          role: "assistant",
          kind: "markdown",
          text: "older text",
          startedAt: "2026-04-17T00:00:00.000Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      sessionRelations: []
    };

    let state = rendererStoreReducer(createInitialRendererStoreState(), {
      type: "store/hydrateSessionWindow",
      sessionId: "session-a",
      snapshot: currentSnapshot,
      mode: "replace"
    });

    state = rendererStoreReducer(state, {
      type: "store/hydrateSessionWindow",
      sessionId: "session-a",
      snapshot: olderSnapshot,
      mode: "prepend",
      cursor: "cursor-10"
    });

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-current-queued-delta", "cursor-9", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-current",
          messageId: "message-current",
          delta: " queued"
        })
      )
    );

    expect(state.entities.turns["turn-older"]?.sessionId).toBe("session-a");
    expect(state.entities.messageBlocks["message-current:md"]?.text).toBe(
      "current text queued"
    );
    expect(state.eventStream.lastCursor).toBe("cursor-9");
  });

  it("uses full snapshot cursors as global barriers for stale stream envelopes", () => {
    const snapshot: DomainSnapshot = {
      conversations: [],
      sessions: [],
      turns: [],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      sessionRelations: []
    };
    let state = rendererStoreReducer(createInitialRendererStoreState(), {
      type: "store/hydrateSnapshot",
      snapshot,
      cursor: "cursor-10"
    });

    expect(state.eventStream.lastCursor).toBe("cursor-10");

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-covered-session-b", "cursor-9", {
          type: "turn.started",
          sessionId: "session-b",
          turnId: "turn-b"
        })
      )
    );

    expect(state.entities.turns["turn-b"]).toBeUndefined();
    expect(state.eventStream.lastCursor).toBe("cursor-10");
  });

  it("stores session context usage from incremental events", () => {
    let state = createInitialRendererStoreState();
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created", "1", {
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
        toEnvelope("evt-context", "2", {
          type: "session.context.updated",
          sessionId: "session-a",
          contextUsage: {
            usedTokens: 42000,
            contextWindow: 128000,
            lastUsedTokens: 2200
          }
        })
      )
    );

    expect(state.entities.sessions["session-a"]?.contextUsage).toMatchObject({
      usedTokens: 42000,
      contextWindow: 128000,
      lastUsedTokens: 2200
    });
  });

  it("stores and clears thread goals from incremental events", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-goal-updated", "1", {
          type: "thread.goal.updated",
          sessionId: "session-a",
          threadId: "thread-a",
          goal: {
            sessionId: "session-a",
            threadId: "thread-a",
            objective: "Wire Codex goal state",
            status: "active",
            tokensUsed: 12,
            timeUsedSeconds: 3,
            createdAt: 1700000000000,
            updatedAt: 1700000001000
          }
        })
      )
    );

    expect(state.entities.threadGoals["session-a"]).toMatchObject({
      sessionId: "session-a",
      threadId: "thread-a",
      objective: "Wire Codex goal state",
      status: "active"
    });

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-goal-cleared", "2", {
          type: "thread.goal.cleared",
          sessionId: "session-a",
          threadId: "thread-a"
        })
      )
    );

    expect(state.entities.threadGoals["session-a"]).toBeUndefined();
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

  it("coalesces adjacent stream deltas during batch ingestion while preserving cursor metadata", () => {
    const initial = createInitialRendererStoreState();
    const state = rendererStoreReducer(initial, {
      type: "store/ingestEnvelopes",
      envelopes: [
        toEnvelope("evt-session", "1", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        }),
        toEnvelope("evt-turn", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        }),
        toEnvelope("evt-message-1", "3", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "hel"
        }),
        toEnvelope("evt-message-2", "4", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "lo"
        }),
        toEnvelope("evt-terminal-1", "5", {
          type: "terminal.output",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          chunk: "out"
        }),
        toEnvelope("evt-terminal-2", "6", {
          type: "terminal.output",
          sessionId: "session-a",
          turnId: "turn-a",
          terminalId: "terminal-a",
          chunk: "put"
        })
      ]
    });

    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe("hello");
    expect(state.entities.terminalStreams["terminal-a"]?.outputText).toBe("output");
    expect(state.eventStream.lastEventId).toBe("evt-terminal-2");
    expect(state.eventStream.lastCursor).toBe("6");
    expect(state.eventStream.recentEventIds).toEqual([
      "evt-session",
      "evt-turn",
      "evt-message-1",
      "evt-message-2",
      "evt-terminal-1",
      "evt-terminal-2"
    ]);
    expect(state.eventStream.seenEventIds["evt-message-1"]).toBe(true);
    expect(state.eventStream.seenEventIds["evt-terminal-1"]).toBe(true);
  });

  it("bounds coalesced stream deltas during batch ingestion", () => {
    const largeChunk = "x".repeat(50_000);
    const state = rendererStoreReducer(createInitialRendererStoreState(), {
      type: "store/ingestEnvelopes",
      envelopes: [
        toEnvelope("evt-message-1", "1", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: largeChunk
        }),
        toEnvelope("evt-message-2", "2", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: largeChunk
        }),
        toEnvelope("evt-message-3", "3", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: largeChunk
        }),
        toEnvelope("evt-message-4", "4", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: largeChunk
        }),
        toEnvelope("evt-message-5", "5", {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: largeChunk
        })
      ]
    });

    expect(state.entities.messageBlocks["message-a:md"]?.text.length).toBeLessThanOrEqual(
      MAX_ACCUMULATED_STREAM_TEXT_LENGTH
    );
    expect(state.entities.messageBlocks["message-a:md"]?.text).toContain("truncated");
  });

  it("updates session titles from session update events", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created", "1", {
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
        toEnvelope("evt-session-title", "2", {
          type: "session.updated",
          conversationId: "conversation-a",
          sessionId: "session-a",
          status: "idle",
          title: "Mini PC research"
        })
      )
    );

    expect(state.entities.sessions["session-a"]).toMatchObject({
      title: "Mini PC research"
    });
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

  it("bounds message.completed finalText kept in renderer state", () => {
    const largeFinalText = "x".repeat(MAX_ACCUMULATED_STREAM_TEXT_LENGTH + 50_000);
    const state = rendererStoreReducer(
      createInitialRendererStoreState(),
      parseIngestEnvelopeAction(
        toEnvelope("evt-message-completed-large-final-text", "1", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          finalText: largeFinalText,
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.messageBlocks["message-a:md"]?.text.length).toBeLessThanOrEqual(
      MAX_ACCUMULATED_STREAM_TEXT_LENGTH
    );
    expect(state.entities.messageBlocks["message-a:md"]?.text).toContain("truncated");
  });

  it("removes stale by-turn index entries when snapshot merge moves entities", () => {
    const baseSnapshot: DomainSnapshot = {
      conversations: [
        {
          conversationId: "conversation-a",
          participantEngineIds: ["agent-a"],
          activeSessionId: "session-a",
          sessionIds: ["session-a"],
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-a",
          conversationId: "conversation-a",
          engineId: "agent-a",
          status: "running",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z"
        }
      ],
      turns: [
        {
          turnId: "turn-old",
          sessionId: "session-a",
          status: "completed",
          startedAt: "2026-04-17T00:00:01.000Z",
          messageIds: ["message-a"],
          toolCallIds: ["tool-a"],
          terminalIds: ["terminal-a"],
          approvalRequestIds: ["approval-a"],
          interactionRequestIds: ["interaction-a"]
        }
      ],
      messageBlocks: [
        {
          blockId: "message-a:md",
          messageId: "message-a",
          sessionId: "session-a",
          turnId: "turn-old",
          role: "assistant",
          kind: "markdown",
          text: "old",
          startedAt: "2026-04-17T00:00:01.000Z"
        }
      ],
      toolCalls: [
        {
          toolCallId: "tool-a",
          sessionId: "session-a",
          turnId: "turn-old",
          toolName: "exec",
          status: "completed",
          startedAt: "2026-04-17T00:00:01.000Z"
        }
      ],
      terminalStreams: [
        {
          terminalId: "terminal-a",
          sessionId: "session-a",
          turnId: "turn-old",
          status: "completed",
          outputText: "old",
          startedAt: "2026-04-17T00:00:01.000Z"
        }
      ],
      approvalRequests: [
        {
          requestId: "approval-a",
          sessionId: "session-a",
          turnId: "turn-old",
          approvalKind: "tool",
          status: "pending",
          title: "Approve exec",
          requestedAt: "2026-04-17T00:00:01.000Z"
        }
      ],
      runtimeInteractions: [
        {
          requestId: "interaction-a",
          sessionId: "session-a",
          turnId: "turn-old",
          interactionKind: "tool_user_input",
          status: "pending",
          title: "Provide input",
          payload: {},
          requestedAt: "2026-04-17T00:00:01.000Z"
        }
      ],
      threadGoals: [],
      participants: [],
      sessionRelations: []
    };
    const movedSnapshot: DomainSnapshot = {
      ...baseSnapshot,
      turns: [
        {
          ...baseSnapshot.turns[0],
          turnId: "turn-new",
          startedAt: "2026-04-17T00:00:02.000Z"
        }
      ],
      messageBlocks: [
        {
          ...baseSnapshot.messageBlocks[0],
          turnId: "turn-new",
          text: "new"
        }
      ],
      toolCalls: [
        {
          ...baseSnapshot.toolCalls[0],
          turnId: "turn-new"
        }
      ],
      terminalStreams: [
        {
          ...baseSnapshot.terminalStreams[0],
          turnId: "turn-new",
          outputText: "new"
        }
      ],
      approvalRequests: [
        {
          ...baseSnapshot.approvalRequests[0],
          turnId: "turn-new"
        }
      ],
      runtimeInteractions: [
        {
          ...baseSnapshot.runtimeInteractions![0],
          turnId: "turn-new"
        }
      ]
    };
    let state = rendererStoreReducer(createInitialRendererStoreState(), {
      type: "store/hydrateSnapshot",
      snapshot: baseSnapshot
    });

    state = rendererStoreReducer(state, {
      type: "store/hydrateSessionWindow",
      sessionId: "session-a",
      snapshot: movedSnapshot,
      mode: "prepend"
    });

    expect(state.indexes.messageBlockIdsByTurn["turn-old"]).toBeUndefined();
    expect(state.indexes.toolCallIdsByTurn["turn-old"]).toBeUndefined();
    expect(state.indexes.terminalIdsByTurn["turn-old"]).toBeUndefined();
    expect(state.indexes.approvalRequestIdsByTurn["turn-old"]).toBeUndefined();
    expect(state.indexes.runtimeInteractionIdsByTurn["turn-old"]).toBeUndefined();
    expect(state.indexes.messageBlockIdsByTurn["turn-new"]).toEqual(["message-a:md"]);
    expect(state.indexes.toolCallIdsByTurn["turn-new"]).toEqual(["tool-a"]);
    expect(state.indexes.terminalIdsByTurn["turn-new"]).toEqual(["terminal-a"]);
    expect(state.indexes.approvalRequestIdsByTurn["turn-new"]).toEqual(["approval-a"]);
    expect(state.indexes.runtimeInteractionIdsByTurn["turn-new"]).toEqual([
      "interaction-a"
    ]);
  });

  it("stores explicit final-message truth on the turn when message.completed marks it", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created-final-marker", "1", {
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
        toEnvelope("evt-turn-started-final-marker", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-message-completed-final-marker", "3", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          finalText: "final answer",
          isFinalForTurn: true,
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.turns["turn-a"]).toMatchObject({
      finalMessageId: "message-a",
      messageIds: ["message-a"]
    });
  });

  it("falls back to the last assistant message when turn.completed arrives without an explicit final marker", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-session-created-turn-fallback", "1", {
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
        toEnvelope("evt-turn-started-turn-fallback", "2", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-user-message-turn-fallback", "3", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-user",
          finalText: "Question",
          participantId: "user-1"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-assistant-message-1-turn-fallback", "4", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-assistant-1",
          finalText: "Draft",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-assistant-message-2-turn-fallback", "5", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-assistant-2",
          finalText: "Final",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-completed-turn-fallback", "6", {
          type: "turn.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          finishReason: "completed"
        })
      )
    );

    expect(state.entities.turns["turn-a"]).toMatchObject({
      finalMessageId: "message-assistant-2"
    });
  });

  it("does not fall back to commentary messages as final answers", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-started-commentary", "1", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-commentary-message", "2", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-commentary",
          finalText: "I will inspect the code first.",
          phase: "commentary",
          engineId: "agent-a"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelope("evt-turn-completed-commentary", "3", {
          type: "turn.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          finishReason: "completed"
        })
      )
    );

    expect(state.entities.turns["turn-a"]?.finalMessageId).toBeUndefined();
    expect(state.entities.messageBlocks["message-commentary:md"]).toMatchObject({
      phase: "commentary"
    });
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

  it("bounds accumulated message, tool, and terminal output kept in renderer state", () => {
    let state = createInitialRendererStoreState();
    const largeChunk = "x".repeat(50_000);

    for (let index = 1; index <= 8; index += 1) {
      state = rendererStoreReducer(
        state,
        parseIngestEnvelopeAction(
          toEnvelopeAt(
            `evt-message-${index}`,
            String(index + 40),
            "2026-04-17T00:00:00.000Z",
            {
              type: "message.delta",
              sessionId: "session-a",
              turnId: "turn-a",
              messageId: "message-a",
              role: "assistant",
              delta: largeChunk,
              engineId: "agent-a"
            }
          )
        )
      );
      state = rendererStoreReducer(
        state,
        parseIngestEnvelopeAction(
          toEnvelopeAt(
            `evt-tool-${index}`,
            String(index),
            "2026-04-17T00:00:00.000Z",
            {
              type: "tool.delta",
              sessionId: "session-a",
              turnId: "turn-a",
              toolCallId: "tool-a",
              delta: largeChunk,
              engineId: "agent-a"
            }
          )
        )
      );
      state = rendererStoreReducer(
        state,
        parseIngestEnvelopeAction(
          toEnvelopeAt(
            `evt-terminal-${index}`,
            String(index + 20),
            "2026-04-17T00:00:00.000Z",
            {
              type: "terminal.output",
              sessionId: "session-a",
              turnId: "turn-a",
              terminalId: "terminal-a",
              chunk: largeChunk,
              engineId: "agent-a"
            }
          )
        )
      );
    }

    expect(state.entities.toolCalls["tool-a"]?.outputSummary?.length).toBeLessThanOrEqual(
      MAX_ACCUMULATED_STREAM_TEXT_LENGTH
    );
    expect(state.entities.toolCalls["tool-a"]?.outputSummary).toContain("truncated");
    expect(state.entities.messageBlocks["message-a:md"]?.text.length).toBeLessThanOrEqual(
      MAX_ACCUMULATED_STREAM_TEXT_LENGTH
    );
    expect(state.entities.messageBlocks["message-a:md"]?.text).toContain("truncated");
    expect(state.entities.terminalStreams["terminal-a"]?.outputText.length).toBeLessThanOrEqual(
      MAX_ACCUMULATED_STREAM_TEXT_LENGTH
    );
    expect(state.entities.terminalStreams["terminal-a"]?.outputText).toContain("truncated");
  });

  it("bounds completed tool output before replacing renderer state", () => {
    let state = createInitialRendererStoreState();
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-tool-delta", "1", "2026-04-17T00:00:00.000Z", {
          type: "tool.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          toolCallId: "tool-a",
          delta: "small output",
          engineId: "agent-a"
        })
      )
    );

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-tool-completed", "2", "2026-04-17T00:00:01.000Z", {
          type: "tool.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          toolCallId: "tool-a",
          status: "completed",
          outputSummary: "x".repeat(MAX_ACCUMULATED_STREAM_TEXT_LENGTH + 1_000),
          engineId: "agent-a"
        })
      )
    );

    expect(state.entities.toolCalls["tool-a"]?.outputSummary?.length).toBeLessThanOrEqual(
      MAX_ACCUMULATED_STREAM_TEXT_LENGTH
    );
    expect(state.entities.toolCalls["tool-a"]?.outputSummary).toContain("truncated");
  });

  it("renders runtime errors as failed turn content when no assistant message exists", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-session-created-error", "1", "2026-04-17T00:00:00.000Z", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "codex",
          status: "running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-turn-started-error", "2", "2026-04-17T00:00:01.000Z", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-error"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-runtime-error", "3", "2026-04-17T00:00:02.000Z", {
          type: "runtime.error",
          sessionId: "session-a",
          turnId: "turn-error",
          code: "other",
          message: "Client sent an HTTP request to an HTTPS server.",
          recoverable: false
        })
      )
    );

    expect(state.entities.sessions["session-a"]).toMatchObject({
      status: "error",
      lastTurnId: "turn-error"
    });
    expect(state.entities.turns["turn-error"]).toMatchObject({
      status: "completed",
      finishReason: "failed",
      messageIds: ["runtime-error:turn-error"]
    });
    expect(state.entities.messageBlocks["runtime-error:turn-error:md"]).toMatchObject({
      role: "system",
      text: "Runtime error (other): Client sent an HTTP request to an HTTPS server."
    });
  });

  it("keeps running turns open for recoverable runtime errors", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-session-created", "1", "2026-04-17T00:00:00.000Z", {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "codex",
          status: "running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-turn-started", "2", "2026-04-17T00:00:01.000Z", {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-running"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-tool-started", "3", "2026-04-17T00:00:02.000Z", {
          type: "tool.started",
          sessionId: "session-a",
          turnId: "turn-running",
          toolCallId: "tool-running",
          toolName: "commandExecution",
          engineId: "codex"
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-reconnect", "4", "2026-04-17T00:00:03.000Z", {
          type: "runtime.error",
          sessionId: "session-a",
          turnId: "turn-running",
          code: "CODEX_APP_SERVER_ERROR",
          message: "Reconnecting... 1/5",
          recoverable: true
        })
      )
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction(
        toEnvelopeAt("evt-assistant-after-reconnect", "5", "2026-04-17T00:00:04.000Z", {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-running",
          messageId: "message-after-reconnect",
          role: "assistant",
          phase: "commentary",
          finalText: "Still running.",
          engineId: "codex"
        })
      )
    );

    expect(state.lastError).toMatchObject({
      code: "CODEX_APP_SERVER_ERROR",
      message: "Reconnecting... 1/5",
      recoverable: true
    });
    expect(state.entities.sessions["session-a"]).toMatchObject({
      status: "running",
      lastTurnId: "turn-running"
    });
    expect(state.entities.turns["turn-running"]?.status).not.toBe("completed");
    expect(state.entities.turns["turn-running"]?.finishReason).toBeUndefined();
    expect(state.entities.messageBlocks["runtime-error:turn-running:md"]).toBeUndefined();
    expect(state.entities.messageBlocks["message-after-reconnect:md"]).toMatchObject({
      text: "Still running."
    });
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

  it("preserves active session while replacing the active session window", () => {
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
            status: "idle",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z"
          },
          {
            sessionId: "session-b",
            conversationId: "conversation-b",
            engineId: "agent-b",
            status: "idle",
            createdAt: "2026-04-17T00:01:00.000Z",
            updatedAt: "2026-04-17T00:01:00.000Z"
          }
        ],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      }
    });
    state = rendererStoreReducer(state, {
      type: "store/setActiveConversation",
      conversationId: "conversation-a"
    });
    state = rendererStoreReducer(state, {
      type: "store/setActiveSession",
      sessionId: "session-a"
    });

    state = rendererStoreReducer(state, {
      type: "store/hydrateSessionWindow",
      sessionId: "session-a",
      mode: "replace",
      snapshot: {
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            sessionIds: ["session-a"],
            activeSessionId: "session-a",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:05.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "completed",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:05.000Z",
            lastTurnId: "turn-a"
          }
        ],
        turns: [
          {
            turnId: "turn-a",
            sessionId: "session-a",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: "2026-04-17T00:00:05.000Z",
            messageIds: ["message-a"],
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
            text: "updated",
            startedAt: "2026-04-17T00:00:01.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      }
    });

    expect(state.activeConversationId).toBe("conversation-a");
    expect(state.activeSessionId).toBe("session-a");
    expect(state.entities.conversations["conversation-b"]).toBeDefined();
    expect(state.entities.sessions["session-b"]).toBeDefined();
    expect(state.entities.turns["turn-a"]).toBeDefined();
    expect(state.entities.messageBlocks["message-a:md"]?.text).toBe("updated");
  });
});
