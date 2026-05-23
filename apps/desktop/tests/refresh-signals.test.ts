import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@another-workbench/shared";
import {
  advanceRendererRefreshSignals,
  createInitialRendererRefreshSignals
} from "../src/store/refresh-signals.js";
import { parseIngestEnvelopeAction } from "../src/store/intake.js";
import { rendererStoreReducer } from "../src/store/reducer.js";
import { createInitialRendererStoreState } from "../src/store/state.js";

const advance = (events: RuntimeEvent[]) =>
  events.reduce(
    (signals, event) => advanceRendererRefreshSignals(signals, event),
    createInitialRendererRefreshSignals()
  );

describe("renderer refresh signals", () => {
  it("ignores high-volume streaming events that are already reflected in local state", () => {
    const signals = advance([
      {
        type: "message.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "hello"
      },
      {
        type: "tool.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        delta: "chunk"
      },
      {
        type: "terminal.output",
        sessionId: "session-1",
        turnId: "turn-1",
        terminalId: "terminal-1",
        chunk: "chunk"
      },
      {
        type: "session.context.updated",
        sessionId: "session-1",
        contextUsage: {
          usedTokens: 10,
          contextWindow: 100,
          lastUsedTokens: 10
        }
      }
    ]);

    expect(signals).toEqual({
      sessionBrowser: 0,
      chatTree: 0,
      takeover: 0
    });
  });

  it("increments only the views invalidated by session and graph events", () => {
    const signals = advance([
      {
        type: "session.created",
        conversationId: "conversation-1",
        sessionId: "session-1",
        engineId: "agent-codex",
        status: "idle"
      },
      {
        type: "session.created",
        conversationId: "conversation-1",
        sessionId: "session-child",
        engineId: "agent-codex",
        status: "idle",
        relation: {
          relationId: "relation-1",
          parentSessionId: "session-1",
          childSessionId: "session-child",
          relationType: "subagent",
          createdAt: "2026-05-17T08:04:30.000Z"
        }
      },
      {
        type: "conversationGraph.updated",
        sessionId: "session-1",
        currentNodeId: "node-1",
        revision: 1,
        visibleNodeIds: ["node-1"],
        visibleTurnIds: ["turn-1"]
      }
    ]);

    expect(signals).toEqual({
      sessionBrowser: 3,
      chatTree: 2,
      takeover: 2
    });
  });

  it("refreshes takeover state when a tool call completes", () => {
    const signals = advance([
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-smart-takeover",
        status: "completed",
        outputSummary: "SmartTakeover enabled for session session-1."
      }
    ]);

    expect(signals).toEqual({
      sessionBrowser: 0,
      chatTree: 0,
      takeover: 1
    });
  });

  it("preserves relevant invalidations even when a streaming event arrives last", () => {
    let state = createInitialRendererStoreState();

    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction({
        eventId: "event-session",
        cursor: "1",
        occurredAt: "2026-05-17T08:04:30.000Z",
        event: {
          type: "session.updated",
          conversationId: "conversation-1",
          sessionId: "session-1",
          status: "running",
          title: "Working"
        }
      })
    );
    state = rendererStoreReducer(
      state,
      parseIngestEnvelopeAction({
        eventId: "event-output",
        cursor: "2",
        occurredAt: "2026-05-17T08:04:30.100Z",
        event: {
          type: "terminal.output",
          sessionId: "session-1",
          turnId: "turn-1",
          terminalId: "terminal-1",
          chunk: "busy output",
          engineId: "agent-codex"
        }
      })
    );

    expect(state.lastEventType).toBe("terminal.output");
    expect(state.eventStream.lastCursor).toBe("2");
    expect(state.refreshSignals.sessionBrowser).toBe(1);
    expect(state.refreshSignals.takeover).toBe(1);
    expect(state.refreshSignals.chatTree).toBe(0);
  });
});
