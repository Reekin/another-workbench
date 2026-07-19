import { describe, expect, it } from "vitest";
import type {
  DomainSnapshot,
  EventEnvelope,
  RuntimeEvent
} from "@another-workbench/shared";
import { DomainProjector } from "@another-workbench/core";
import { MAX_ACCUMULATED_STREAM_TEXT_LENGTH } from "@another-workbench/shared";
import { parseIngestEnvelopeAction } from "../src/store/intake.js";
import { rendererStoreReducer } from "../src/store/reducer.js";
import { selectEventStreamState, selectTurnsForSession } from "../src/store/selectors.js";
import { createInitialRendererStoreState } from "../src/store/state.js";
import { createRendererStore } from "../src/store/store.js";
import type { RendererStoreState } from "../src/store/types.js";

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

it("preserves canonical turn collections across duplicate turn.started events", () => {
  let state = createInitialRendererStoreState();
  for (const envelope of [
    toEnvelope("session", "1", {
      type: "session.created",
      conversationId: "conversation-1",
      sessionId: "session-1",
      engineId: "codex",
      status: "idle"
    }),
    toEnvelope("turn", "2", {
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    }),
    toEnvelope("message", "3", {
      type: "message.started",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-1",
      role: "user",
      engineId: "codex"
    }),
    toEnvelope("turn-completed", "4", {
      type: "turn.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      finishReason: "completed"
    }),
    toEnvelope("turn-duplicate", "5", {
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    })
  ]) {
    state = rendererStoreReducer(state, parseIngestEnvelopeAction(envelope));
  }

  expect(state.entities.turns["turn-1"]).toMatchObject({
    status: "completed",
    messageIds: ["message-1"]
  });
  expect(state.entities.sessions["session-1"]?.status).toBe("idle");
});

type ConformanceEvent = {
  occurredAt: string;
  event: RuntimeEvent;
};

const sortBy = <T>(items: readonly T[], selectId: (item: T) => string): T[] =>
  [...items].sort((left, right) => selectId(left).localeCompare(selectId(right)));

const canonicalProjectionFromSnapshot = (snapshot: DomainSnapshot) => ({
  conversations: sortBy(snapshot.conversations, (conversation) => conversation.conversationId).map(
    (conversation) => ({
      conversationId: conversation.conversationId,
      workspaceId: conversation.workspaceId,
      participantEngineIds: [...conversation.participantEngineIds],
      activeSessionId: conversation.activeSessionId,
      sessionIds: [...conversation.sessionIds],
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archivedAt: conversation.archivedAt,
      metadata: conversation.metadata
    })
  ),
  sessions: sortBy(snapshot.sessions, (session) => session.sessionId).map((session) => ({
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    engineId: session.engineId,
    status: session.status,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    lastTurnId: session.lastTurnId,
    contextUsage: session.contextUsage,
    metadata: session.metadata
  })),
  turns: sortBy(snapshot.turns, (turn) => turn.turnId).map((turn) => ({
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    status: turn.status,
    finishReason: turn.finishReason,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    actor: turn.actor,
    finalMessageId: turn.finalMessageId,
    messageIds: [...turn.messageIds],
    toolCallIds: [...turn.toolCallIds],
    terminalIds: [...turn.terminalIds],
    approvalRequestIds: [...turn.approvalRequestIds],
    interactionRequestIds: [...turn.interactionRequestIds]
  })),
  messageBlocks: sortBy(snapshot.messageBlocks, (block) => block.blockId).map((block) => ({
    blockId: block.blockId,
    messageId: block.messageId,
    sessionId: block.sessionId,
    turnId: block.turnId,
    role: block.role,
    phase: block.phase,
    kind: block.kind,
    text: block.text,
    toolCallId: block.toolCallId,
    terminalId: block.terminalId,
    requestId: block.requestId,
    actor: block.actor,
    startedAt: block.startedAt,
    completedAt: block.completedAt
  })),
  toolCalls: sortBy(snapshot.toolCalls, (toolCall) => toolCall.toolCallId).map(
    (toolCall) => ({
      toolCallId: toolCall.toolCallId,
      sessionId: toolCall.sessionId,
      turnId: toolCall.turnId,
      toolName: toolCall.toolName,
      status: toolCall.status,
      inputSummary: toolCall.inputSummary,
      outputSummary: toolCall.outputSummary,
      actor: toolCall.actor,
      startedAt: toolCall.startedAt,
      completedAt: toolCall.completedAt
    })
  ),
  terminalStreams: sortBy(snapshot.terminalStreams, (stream) => stream.terminalId).map(
    (stream) => ({
      terminalId: stream.terminalId,
      sessionId: stream.sessionId,
      turnId: stream.turnId,
      toolCallId: stream.toolCallId,
      status: stream.status,
      outputText: stream.outputText,
      exitCode: stream.exitCode,
      actor: stream.actor,
      startedAt: stream.startedAt,
      completedAt: stream.completedAt
    })
  ),
  approvalRequests: sortBy(snapshot.approvalRequests, (approval) => approval.requestId).map(
    (approval) => ({
      requestId: approval.requestId,
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      approvalKind: approval.approvalKind,
      status: approval.status,
      title: approval.title,
      details: approval.details,
      note: approval.note,
      availableActions: [...approval.availableActions],
      metadata: approval.metadata,
      actor: approval.actor,
      requestedAt: approval.requestedAt,
      resolvedAt: approval.resolvedAt
    })
  ),
  runtimeInteractions: sortBy(
    snapshot.runtimeInteractions,
    (interaction) => interaction.requestId
  ).map((interaction) => ({
    requestId: interaction.requestId,
    sessionId: interaction.sessionId,
    turnId: interaction.turnId,
    interactionKind: interaction.interactionKind,
    status: interaction.status,
    title: interaction.title,
    details: interaction.details,
    payload: interaction.payload,
    response: interaction.response,
    actor: interaction.actor,
    requestedAt: interaction.requestedAt,
    resolvedAt: interaction.resolvedAt
  })),
  participants: sortBy(snapshot.participants, (participant) => participant.participantId).map(
    (participant) => ({
      participantId: participant.participantId,
      conversationId: participant.conversationId,
      engineId: participant.engineId,
      role: participant.role,
      capabilities: [...participant.capabilities],
      activeSessionIds: [...participant.activeSessionIds].sort(),
      metadata: participant.metadata
    })
  ),
  threadGoals: sortBy(snapshot.threadGoals, (goal) => goal.sessionId).map((goal) => ({
    sessionId: goal.sessionId,
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    turnId: goal.turnId
  })),
  sessionRelations: sortBy(snapshot.sessionRelations, (relation) => relation.relationId).map(
    (relation) => ({
      relationId: relation.relationId,
      parentSessionId: relation.parentSessionId,
      childSessionId: relation.childSessionId,
      relationType: relation.relationType,
      sourceTurnId: relation.sourceTurnId,
      createdAt: relation.createdAt,
      metadata: relation.metadata
    })
  )
});

const snapshotFromRendererState = (state: RendererStoreState): DomainSnapshot => ({
  conversations: Object.values(state.entities.conversations),
  sessions: Object.values(state.entities.sessions),
  turns: Object.values(state.entities.turns),
  messageBlocks: Object.values(state.entities.messageBlocks),
  toolCalls: Object.values(state.entities.toolCalls),
  terminalStreams: Object.values(state.entities.terminalStreams),
  approvalRequests: Object.values(state.entities.approvalRequests),
  runtimeInteractions: Object.values(state.entities.runtimeInteractions),
  participants: Object.values(state.entities.participants),
  threadGoals: Object.values(state.entities.threadGoals),
  sessionRelations: Object.values(state.entities.sessionRelations)
});

const expectRendererToMatchCoreProjection = (
  conversationId: string,
  events: ConformanceEvent[]
): void => {
  const projector = new DomainProjector();
  let rendererState = createInitialRendererStoreState();

  events.forEach(({ event, occurredAt }, index) => {
    projector.apply(event, occurredAt);
    rendererState = rendererStoreReducer(
      rendererState,
      parseIngestEnvelopeAction(
        toEnvelopeAt(`evt-conformance-${index + 1}`, String(index + 1), occurredAt, event)
      )
    );
  });

  expect(canonicalProjectionFromSnapshot(snapshotFromRendererState(rendererState))).toEqual(
    canonicalProjectionFromSnapshot(projector.store.getConversationSnapshot(conversationId))
  );
};

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
          status: "streaming",
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

    const store = createRendererStore();
    store.hydrateSessionWindow("session-a", snapshot, "replace", "cursor-10");

    store.ingestEnvelope(
      toEnvelope("evt-stale-delta", "cursor-9", {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-a",
        messageId: "message-a",
        delta: " stale"
      })
    );
    let state = store.getState();

    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe("latest text");
    expect(state.eventStream.lastCursor).toBeUndefined();

    store.ingestEnvelope(
      toEnvelope("evt-other-session", "cursor-9", {
        type: "session.created",
        conversationId: "conversation-b",
        sessionId: "session-b",
        engineId: "agent-b",
        status: "idle"
      })
    );
    state = store.getState();

    expect(store.getDomainReadModel().getSession("session-b")?.sessionId).toBe("session-b");
    expect(state.eventStream.lastCursor).toBe("cursor-9");

    store.ingestEnvelope(
      toEnvelope("evt-covered-delta", "cursor-10", {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-a",
        messageId: "message-a",
        delta: " covered"
      })
    );
    state = store.getState();

    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe("latest text");
    expect(state.eventStream.lastCursor).toBe("cursor-9");

    store.ingestEnvelope(
      toEnvelope("evt-live-delta", "cursor-11", {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-a",
        messageId: "message-a",
        delta: " live"
      })
    );
    state = store.getState();

    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe(
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
          status: "streaming",
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

    const store = createRendererStore();
    store.hydrateSessionWindow("session-a", currentSnapshot, "replace");
    store.hydrateSessionWindow("session-a", olderSnapshot, "prepend", "cursor-10");

    store.ingestEnvelope(
      toEnvelope("evt-current-queued-delta", "cursor-9", {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-current",
        messageId: "message-current",
        delta: " queued"
      })
    );
    const state = store.getState();

    expect(store.getDomainReadModel().getTurn("turn-older")?.sessionId).toBe("session-a");
    expect(store.getDomainReadModel().getMessageBlock("message-current:md")?.text).toBe(
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

  it("matches core canonical projection for session and turn lifecycle entities", () => {
    expectRendererToMatchCoreProjection("conversation-a", [
      {
        occurredAt: "2026-04-17T00:10:00.000Z",
        event: {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:01.000Z",
        event: {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-b",
          engineId: "agent-a",
          status: "running",
          relation: {
            relationId: "relation-a-b",
            parentSessionId: "session-a",
            childSessionId: "session-b",
            relationType: "fork",
            createdAt: "2026-04-17T00:10:01.000Z"
          }
        }
      },
      {
        occurredAt: "2026-04-17T00:10:02.000Z",
        event: {
          type: "participant.updated",
          conversationId: "conversation-a",
          participantId: "participant-conversation-a-agent-a",
          engineId: "agent-a",
          role: "primary",
          capabilities: ["chat"]
        }
      },
      {
        occurredAt: "2026-04-17T00:10:03.000Z",
        event: {
          type: "turn.started",
          sessionId: "session-b",
          turnId: "turn-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:04.000Z",
        event: {
          type: "message.started",
          sessionId: "session-b",
          turnId: "turn-a",
          messageId: "message-a",
          role: "assistant",
          phase: "final_answer",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:05.000Z",
        event: {
          type: "message.delta",
          sessionId: "session-b",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "hello",
          phase: "final_answer",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:06.000Z",
        event: {
          type: "message.completed",
          sessionId: "session-b",
          turnId: "turn-a",
          messageId: "message-a",
          finalText: "hello",
          isFinalForTurn: true,
          phase: "final_answer",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:07.000Z",
        event: {
          type: "tool.started",
          sessionId: "session-b",
          turnId: "turn-a",
          toolCallId: "tool-a",
          toolName: "shell",
          inputSummary: "echo hello",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:08.000Z",
        event: {
          type: "tool.delta",
          sessionId: "session-b",
          turnId: "turn-a",
          toolCallId: "tool-a",
          delta: "hello",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:09.000Z",
        event: {
          type: "tool.completed",
          sessionId: "session-b",
          turnId: "turn-a",
          toolCallId: "tool-a",
          status: "completed",
          outputSummary: "hello",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:10.000Z",
        event: {
          type: "terminal.started",
          sessionId: "session-b",
          turnId: "turn-a",
          terminalId: "terminal-a",
          toolCallId: "tool-a",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:11.000Z",
        event: {
          type: "terminal.output",
          sessionId: "session-b",
          turnId: "turn-a",
          terminalId: "terminal-a",
          chunk: "hello\n",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:12.000Z",
        event: {
          type: "terminal.completed",
          sessionId: "session-b",
          turnId: "turn-a",
          terminalId: "terminal-a",
          exitCode: 0,
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:13.000Z",
        event: {
          type: "approval.requested",
          sessionId: "session-b",
          turnId: "turn-a",
          requestId: "approval-a",
          approvalKind: "command",
          title: "Run command",
          details: "Allow echo",
          availableActions: ["approve", "deny"],
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:14.000Z",
        event: {
          type: "approval.resolved",
          sessionId: "session-b",
          turnId: "turn-a",
          requestId: "approval-a",
          action: "approve",
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:15.000Z",
        event: {
          type: "interaction.requested",
          sessionId: "session-b",
          turnId: "turn-a",
          requestId: "interaction-a",
          interactionKind: "tool_user_input",
          title: "Need input",
          details: "Provide a value",
          payload: { prompt: "value" },
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:16.000Z",
        event: {
          type: "interaction.resolved",
          sessionId: "session-b",
          turnId: "turn-a",
          requestId: "interaction-a",
          action: "submit",
          response: { value: "ok" },
          engineId: "agent-a"
        }
      },
      {
        occurredAt: "2026-04-17T00:10:17.000Z",
        event: {
          type: "thread.goal.updated",
          sessionId: "session-b",
          threadId: "thread-b",
          turnId: "turn-a",
          goal: {
            sessionId: "session-b",
            threadId: "thread-b",
            objective: "Finish task",
            status: "active",
            tokensUsed: 1,
            timeUsedSeconds: 2,
            createdAt: 10,
            updatedAt: 20,
            turnId: "turn-a"
          }
        }
      },
      {
        occurredAt: "2026-04-17T00:10:18.000Z",
        event: {
          type: "turn.completed",
          sessionId: "session-b",
          turnId: "turn-a",
          finishReason: "completed"
        }
      }
    ]);
  });

  it("matches core canonical projection for runtime errors", () => {
    expectRendererToMatchCoreProjection("conversation-a", [
      {
        occurredAt: "2026-04-17T00:20:00.000Z",
        event: {
          type: "session.created",
          conversationId: "conversation-a",
          sessionId: "session-a",
          engineId: "agent-a",
          status: "running"
        }
      },
      {
        occurredAt: "2026-04-17T00:20:01.000Z",
        event: {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-error"
        }
      },
      {
        occurredAt: "2026-04-17T00:20:02.000Z",
        event: {
          type: "runtime.error",
          sessionId: "session-a",
          turnId: "turn-error",
          code: "RUNTIME_FAIL",
          message: "Boom",
          recoverable: false
        }
      }
    ]);
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
    const store = createRendererStore();
    store.hydrateSnapshot({
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            activeSessionId: "session-a",
            sessionIds: ["session-a"],
            createdAt: "2026-04-19T00:00:00.000Z",
            updatedAt: "2026-04-19T00:00:00.000Z"
          },
          {
            conversationId: "conversation-b",
            participantEngineIds: ["agent-b"],
            activeSessionId: "session-b",
            sessionIds: ["session-b"],
            createdAt: "2026-04-19T00:00:01.000Z",
            updatedAt: "2026-04-19T00:00:01.000Z"
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
    });

    const state = store.disposeSession("session-a");

    expect(store.getDomainReadModel().getSession("session-a")).toBeUndefined();
    expect(store.getDomainReadModel().getTurn("turn-a")).toBeUndefined();
    expect(store.getDomainReadModel().getSession("session-b")).toBeDefined();
    expect(store.getDomainReadModel().getTurn("turn-b")).toBeDefined();
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
    const store = createRendererStore();
    store.hydrateSnapshot(baseSnapshot);
    const state = store.hydrateSessionWindow(
      "session-a",
      movedSnapshot,
      "prepend"
    );

    const domain = store.getDomainReadModel();
    expect(domain.listMessageBlocks({ turnId: "turn-old" })).toEqual([]);
    expect(domain.listToolCalls({ turnId: "turn-old" })).toEqual([]);
    expect(domain.listTerminalStreams({ turnId: "turn-old" })).toEqual([]);
    expect(domain.listApprovalRequests({ turnId: "turn-old" })).toEqual([]);
    expect(domain.listRuntimeInteractions({ sessionId: "session-a" }).filter((item) => item.turnId === "turn-old")).toEqual([]);
    expect(domain.listMessageBlocks({ turnId: "turn-new" }).map((item) => item.blockId)).toEqual(["message-a:md"]);
    expect(domain.listToolCalls({ turnId: "turn-new" }).map((item) => item.toolCallId)).toEqual(["tool-a"]);
    expect(domain.listTerminalStreams({ turnId: "turn-new" }).map((item) => item.terminalId)).toEqual(["terminal-a"]);
    expect(domain.listApprovalRequests({ turnId: "turn-new" }).map((item) => item.requestId)).toEqual(["approval-a"]);
    expect(domain.listRuntimeInteractions({ sessionId: "session-a" }).filter((item) => item.turnId === "turn-new").map((item) => item.requestId)).toEqual(["interaction-a"]);
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
    const store = createRendererStore();
    store.hydrateSnapshot({
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
            role: "primary",
            capabilities: [],
            activeSessionIds: ["session-a"],
            joinedAt: "2026-04-17T00:00:00.000Z"
          },
          {
            participantId: "participant-b",
            conversationId: "conversation-b",
            engineId: "agent-b",
            role: "primary",
            capabilities: [],
            activeSessionIds: ["session-b"],
            joinedAt: "2026-04-17T00:01:00.000Z"
          }
        ],
        sessionRelations: []
    });

    const state = store.disposeSession("session-a");

    const domain = store.getDomainReadModel();
    expect(domain.getSession("session-a")).toBeUndefined();
    expect(domain.getTurn("turn-a")).toBeUndefined();
    expect(domain.getMessageBlock("message-a:md")).toBeUndefined();
    expect(domain.getToolCall("tool-a")).toBeUndefined();
    expect(domain.getTerminalStream("terminal-a")).toBeUndefined();
    expect(domain.getApprovalRequest("approval-a")).toBeUndefined();
    expect(domain.getConversation("conversation-a")?.sessionIds).toEqual([]);
    expect(domain.getParticipant("participant-a")?.activeSessionIds).toEqual([]);
    expect(state.activeSessionId).toBe("session-b");
    expect(domain.getSession("session-b")).toBeDefined();
    expect(domain.getTurn("turn-b")).toBeDefined();
  });

  it("preserves active session while replacing the active session window", () => {
    const store = createRendererStore();
    store.hydrateSnapshot({
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
    });
    store.dispatch({
      type: "store/setActiveConversation",
      conversationId: "conversation-a"
    });
    store.dispatch({
      type: "store/setActiveSession",
      sessionId: "session-a"
    });

    const state = store.hydrateSessionWindow("session-a", {
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
      },
      "replace"
    );

    expect(state.activeConversationId).toBe("conversation-a");
    expect(state.activeSessionId).toBe("session-a");
    expect(store.getDomainReadModel().getConversation("conversation-b")).toBeDefined();
    expect(store.getDomainReadModel().getSession("session-b")).toBeDefined();
    expect(store.getDomainReadModel().getTurn("turn-a")).toBeDefined();
    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe("updated");
  });

  it("preserves already loaded session turns outside the replaced session window", () => {
    const store = createRendererStore();
    store.hydrateSnapshot({
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            sessionIds: ["session-a"],
            activeSessionId: "session-a",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:10.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "running",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:10.000Z",
            lastTurnId: "turn-new"
          }
        ],
        turns: [
          {
            turnId: "turn-old",
            sessionId: "session-a",
            status: "completed",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: "2026-04-17T00:00:02.000Z",
            messageIds: ["message-old"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-new",
            sessionId: "session-a",
            status: "streaming",
            startedAt: "2026-04-17T00:00:10.000Z",
            messageIds: ["message-new"],
            toolCallIds: ["tool-stale"],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-old:md",
            messageId: "message-old",
            sessionId: "session-a",
            turnId: "turn-old",
            role: "user",
            kind: "markdown",
            text: "old prompt",
            startedAt: "2026-04-17T00:00:01.000Z"
          },
          {
            blockId: "message-new:md",
            messageId: "message-new",
            sessionId: "session-a",
            turnId: "turn-new",
            role: "assistant",
            kind: "markdown",
            text: "stale",
            startedAt: "2026-04-17T00:00:10.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-stale",
            sessionId: "session-a",
            turnId: "turn-new",
            toolName: "shell",
            status: "running",
            startedAt: "2026-04-17T00:00:10.500Z"
          }
        ],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
    });

    const state = store.hydrateSessionWindow("session-a", {
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            sessionIds: ["session-a"],
            activeSessionId: "session-a",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:12.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "running",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:12.000Z",
            lastTurnId: "turn-new"
          }
        ],
        turns: [
          {
            turnId: "turn-new",
            sessionId: "session-a",
            status: "streaming",
            startedAt: "2026-04-17T00:00:10.000Z",
            messageIds: ["message-new"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ],
        messageBlocks: [
          {
            blockId: "message-new:md",
            messageId: "message-new",
            sessionId: "session-a",
            turnId: "turn-new",
            role: "assistant",
            kind: "markdown",
            text: "fresh",
            startedAt: "2026-04-17T00:00:10.000Z"
          }
        ],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: [],
        sessionRelations: []
      },
      "replace",
      "cursor-20"
    );

    const domain = store.getDomainReadModel();
    expect(domain.getTurn("turn-old")).toBeDefined();
    expect(domain.getMessageBlock("message-old:md")?.text).toBe("old prompt");
    expect(domain.getTurn("turn-new")?.messageIds).toEqual(["message-new"]);
    expect(domain.getMessageBlock("message-new:md")?.text).toBe("fresh");
    expect(domain.getToolCall("tool-stale")).toBeUndefined();
    expect(domain.listTurns({ sessionId: "session-a" }).map((turn) => turn.turnId)).toEqual([
      "turn-old",
      "turn-new"
    ]);
    expect(domain.listToolCalls({ turnId: "turn-new" })).toEqual([]);
  });
});
