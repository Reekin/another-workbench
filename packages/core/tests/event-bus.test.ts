import { describe, expect, it } from "vitest";
import {
  MAX_ACCUMULATED_STREAM_TEXT_LENGTH,
  MAX_STREAM_EVENT_CHUNK_LENGTH
} from "@another-workbench/shared";
import type { RuntimeEventEnvelope } from "../src/event-bus.js";
import { RuntimeEventBus } from "../src/event-bus.js";

const now = "2026-04-17T00:00:00.000Z";

describe("RuntimeEventBus", () => {
  it("routes events to all subscribers by default", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: () => "evt-1"
    });
    const received: RuntimeEventEnvelope[] = [];

    bus.subscribe((envelope) => {
      received.push(envelope);
    });

    const envelope = bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a"
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(envelope);
    expect(envelope.cursor).toBe("1");
    expect(envelope.eventId).toBe("evt-1");
  });

  it("supports event type and sessionId filters", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: () => "evt-filter"
    });
    const targeted: RuntimeEventEnvelope[] = [];

    bus.subscribe(
      (envelope) => {
        targeted.push(envelope);
      },
      { sessionId: "session-a", eventTypes: ["turn.started"] }
    );

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a"
    });
    bus.publish({
      type: "turn.completed",
      sessionId: "session-a",
      turnId: "turn-a",
      finishReason: "completed"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-b",
      turnId: "turn-b"
    });

    expect(targeted).toHaveLength(1);
    expect(targeted[0].event.sessionId).toBe("session-a");
    expect(targeted[0].event.type).toBe("turn.started");
  });

  it("supports conversationId filter for events that include conversationId", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: () => "evt-conversation-direct"
    });
    const targeted: RuntimeEventEnvelope[] = [];

    bus.subscribe(
      (envelope) => {
        targeted.push(envelope);
      },
      { conversationId: "conversation-a", eventTypes: ["session.created"] }
    );

    bus.publish({
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-a",
      engineId: "agent-a",
      status: "idle"
    });
    bus.publish({
      type: "session.created",
      conversationId: "conversation-b",
      sessionId: "session-b",
      engineId: "agent-b",
      status: "idle"
    });

    expect(targeted).toHaveLength(1);
    expect(targeted[0].event.type).toBe("session.created");
    if (targeted[0].event.type === "session.created") {
      expect(targeted[0].event.conversationId).toBe("conversation-a");
    }
  });

  it("supports conversationId filter for session-scoped events via resolver", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: () => "evt-conversation-session",
      resolveConversationIdBySessionId: (sessionId) => {
        if (sessionId === "session-a") {
          return "conversation-a";
        }
        if (sessionId === "session-b") {
          return "conversation-b";
        }
        return undefined;
      }
    });
    const targeted: RuntimeEventEnvelope[] = [];

    bus.subscribe(
      (envelope) => {
        targeted.push(envelope);
      },
      { conversationId: "conversation-a", eventTypes: ["turn.started"] }
    );

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-b",
      turnId: "turn-b"
    });

    expect(targeted).toHaveLength(1);
    expect(targeted[0].event.type).toBe("turn.started");
    if (targeted[0].event.type === "turn.started") {
      expect(targeted[0].event.sessionId).toBe("session-a");
    }
  });

  it("unsubscribes listeners", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: () => "evt-unsub"
    });
    const received: RuntimeEventEnvelope[] = [];

    const unsubscribe = bus.subscribe((envelope) => {
      received.push(envelope);
    });
    unsubscribe();

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a"
    });

    expect(received).toHaveLength(0);
    expect(bus.getSubscriberCount()).toBe(0);
  });

  it("delegates readSinceCursor to replay port", () => {
    const replayEvents: RuntimeEventEnvelope[] = [
      {
        eventId: "evt-replay",
        cursor: "42",
        occurredAt: now,
        event: {
          type: "turn.started",
          sessionId: "session-a",
          turnId: "turn-a"
        }
      }
    ];

    const bus = new RuntimeEventBus({
      replayPort: {
        readSinceCursor: (cursor) => {
          if (cursor === "41") {
            return replayEvents;
          }
          return [];
        }
      }
    });

    expect(bus.readSinceCursor("41")).toEqual(replayEvents);
    expect(bus.readSinceCursor("not-found")).toEqual([]);
  });

  it("bounds oversized replay port payloads before returning them", () => {
    const oversizedReplayEvents: RuntimeEventEnvelope[] = [
      {
        eventId: "evt-replay-message-delta",
        cursor: "42",
        occurredAt: now,
        event: {
          type: "message.delta",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          delta: "m".repeat(MAX_STREAM_EVENT_CHUNK_LENGTH + 10)
        }
      },
      {
        eventId: "evt-replay-message-completed",
        cursor: "43",
        occurredAt: now,
        event: {
          type: "message.completed",
          sessionId: "session-a",
          turnId: "turn-a",
          messageId: "message-a",
          finalText: "f".repeat(MAX_ACCUMULATED_STREAM_TEXT_LENGTH + 10)
        }
      }
    ];
    const replayBus = new RuntimeEventBus({
      replayPort: {
        replay: () => oversizedReplayEvents
      }
    });
    const readSinceBus = new RuntimeEventBus({
      replayPort: {
        readSinceCursor: () => oversizedReplayEvents
      }
    });

    for (const replayed of [
      replayBus.replay(),
      readSinceBus.readSinceCursor("41")
    ]) {
      expect(replayed[0]?.event.type).toBe("message.delta");
      if (replayed[0]?.event.type === "message.delta") {
        expect(replayed[0].event.delta.length).toBeLessThanOrEqual(
          MAX_STREAM_EVENT_CHUNK_LENGTH
        );
        expect(replayed[0].event.delta).toContain("truncated");
      }
      expect(replayed[1]?.event.type).toBe("message.completed");
      if (replayed[1]?.event.type === "message.completed") {
        expect(replayed[1].event.finalText?.length).toBeLessThanOrEqual(
          MAX_ACCUMULATED_STREAM_TEXT_LENGTH
        );
        expect(replayed[1].event.finalText).toContain("truncated");
      }
    }
  });

  it("supports filtered replay with cursor range from in-memory history", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: (() => {
        let sequence = 0;
        return () => `evt-${++sequence}`;
      })()
    });

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-1"
    });
    bus.publish({
      type: "turn.completed",
      sessionId: "session-a",
      turnId: "turn-a-1",
      finishReason: "completed"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-b",
      turnId: "turn-b-1"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-2"
    });

    const replayed = bus.replay({
      fromCursor: "1",
      toCursor: "3",
      filter: {
        sessionId: "session-a"
      }
    });
    expect(replayed.map((envelope) => envelope.cursor)).toEqual(["2"]);
    expect(replayed[0]?.event.type).toBe("turn.completed");

    const continued = bus.readSinceCursor("2", {
      sessionId: "session-a",
      eventTypes: ["turn.started"]
    });
    expect(continued.map((envelope) => envelope.cursor)).toEqual(["4"]);
  });

  it("keeps a bounded replay buffer for reconnect semantics", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      maxReplayEnvelopes: 2,
      createId: (() => {
        let sequence = 0;
        return () => `evt-bounded-${++sequence}`;
      })()
    });

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-1"
    });
    bus.publish({
      type: "turn.completed",
      sessionId: "session-a",
      turnId: "turn-a-1",
      finishReason: "completed"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-2"
    });

    const replayed = bus.replay({
      fromCursor: "2"
    });
    expect(replayed).toHaveLength(1);
    expect(replayed.map((envelope) => envelope.cursor)).toEqual(["3"]);
  });

  it("does not replay from the start when an in-memory fromCursor expired", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      maxReplayEnvelopes: 2,
      createId: (() => {
        let sequence = 0;
        return () => `evt-expired-${++sequence}`;
      })()
    });

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-1"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-2"
    });
    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-3"
    });

    expect(bus.replayResult({ fromCursor: "1" })).toEqual({
      status: "gap",
      reason: "cursor_not_found",
      replayed: 0,
      fromCursor: "1",
      toCursor: undefined,
      envelopes: []
    });
    expect(bus.replay({ fromCursor: "1" })).toEqual([]);
  });

  it("distinguishes a valid empty replay from a cursor gap", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: (() => {
        let sequence = 0;
        return () => `evt-empty-${++sequence}`;
      })()
    });

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-1"
    });
    bus.publish({
      type: "turn.completed",
      sessionId: "session-a",
      turnId: "turn-a-1",
      finishReason: "completed"
    });

    expect(bus.replayResult({ fromCursor: "2" })).toEqual({
      status: "ok",
      replayed: 0,
      fromCursor: "2",
      toCursor: undefined,
      envelopes: []
    });
    expect(bus.replayResult({ fromCursor: "cursor-missing" })).toMatchObject({
      status: "gap",
      reason: "cursor_not_found",
      replayed: 0,
      fromCursor: "cursor-missing",
      envelopes: []
    });
  });

  it("replays backlog before continuing live delivery for fromCursor subscriptions", () => {
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: (() => {
        let sequence = 0;
        return () => `evt-subscribe-${++sequence}`;
      })()
    });

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-1"
    });
    bus.publish({
      type: "turn.completed",
      sessionId: "session-a",
      turnId: "turn-a-1",
      finishReason: "completed"
    });

    const received: string[] = [];
    bus.subscribeWithReplay(
      (envelope) => {
        received.push(`${envelope.cursor}:${envelope.event.type}`);
      },
      {
        fromCursor: "1",
        filter: {
          sessionId: "session-a"
        }
      }
    );

    bus.publish({
      type: "turn.started",
      sessionId: "session-a",
      turnId: "turn-a-2"
    });

    expect(received).toEqual([
      "2:turn.completed",
      "3:turn.started"
    ]);
    expect(bus.getLatestCursor()).toBe("3");
  });

  it("bounds stream payloads before delivery and replay", () => {
    const published: RuntimeEventEnvelope[] = [];
    const bus = new RuntimeEventBus({
      now: () => now,
      createId: (() => {
        let sequence = 0;
        return () => `evt-limited-${++sequence}`;
      })(),
      replayPort: {
        onEventPublished: (envelope) => {
          published.push(envelope);
        }
      }
    });
    const received: RuntimeEventEnvelope[] = [];
    bus.subscribe((envelope) => {
      received.push(envelope);
    });

    bus.publish({
      type: "message.delta",
      sessionId: "session-a",
      turnId: "turn-a",
      messageId: "message-a",
      role: "assistant",
      delta: "m".repeat(MAX_STREAM_EVENT_CHUNK_LENGTH + 10),
      engineId: "agent-a"
    });
    bus.publish({
      type: "message.completed",
      sessionId: "session-a",
      turnId: "turn-a",
      messageId: "message-a",
      finalText: "f".repeat(MAX_ACCUMULATED_STREAM_TEXT_LENGTH + 10),
      engineId: "agent-a"
    });
    bus.publish({
      type: "tool.delta",
      sessionId: "session-a",
      turnId: "turn-a",
      toolCallId: "tool-a",
      delta: "x".repeat(MAX_STREAM_EVENT_CHUNK_LENGTH + 10),
      engineId: "agent-a"
    });
    bus.publish({
      type: "terminal.output",
      sessionId: "session-a",
      turnId: "turn-a",
      terminalId: "terminal-a",
      chunk: "y".repeat(MAX_STREAM_EVENT_CHUNK_LENGTH + 10),
      engineId: "agent-a"
    });
    bus.publish({
      type: "tool.completed",
      sessionId: "session-a",
      turnId: "turn-a",
      toolCallId: "tool-a",
      status: "completed",
      outputSummary: "z".repeat(MAX_ACCUMULATED_STREAM_TEXT_LENGTH + 10),
      engineId: "agent-a"
    });

    const replayed = bus.replay();
    expect(received).toEqual(replayed);
    expect(published).toEqual(replayed);
    expect(replayed[0]?.event.type).toBe("message.delta");
    if (replayed[0]?.event.type === "message.delta") {
      expect(replayed[0].event.delta.length).toBeLessThanOrEqual(
        MAX_STREAM_EVENT_CHUNK_LENGTH
      );
      expect(replayed[0].event.delta).toContain("truncated");
    }
    expect(replayed[1]?.event.type).toBe("message.completed");
    if (replayed[1]?.event.type === "message.completed") {
      expect(replayed[1].event.finalText?.length).toBeLessThanOrEqual(
        MAX_ACCUMULATED_STREAM_TEXT_LENGTH
      );
      expect(replayed[1].event.finalText).toContain("truncated");
    }
    expect(replayed[2]?.event.type).toBe("tool.delta");
    if (replayed[2]?.event.type === "tool.delta") {
      expect(replayed[2].event.delta.length).toBeLessThanOrEqual(
        MAX_STREAM_EVENT_CHUNK_LENGTH
      );
      expect(replayed[2].event.delta).toContain("truncated");
    }
    expect(replayed[3]?.event.type).toBe("terminal.output");
    if (replayed[3]?.event.type === "terminal.output") {
      expect(replayed[3].event.chunk.length).toBeLessThanOrEqual(
        MAX_STREAM_EVENT_CHUNK_LENGTH
      );
      expect(replayed[3].event.chunk).toContain("truncated");
    }
    expect(replayed[4]?.event.type).toBe("tool.completed");
    if (replayed[4]?.event.type === "tool.completed") {
      expect(replayed[4].event.outputSummary?.length).toBeLessThanOrEqual(
        MAX_ACCUMULATED_STREAM_TEXT_LENGTH
      );
      expect(replayed[4].event.outputSummary).toContain("truncated");
    }
  });
});
