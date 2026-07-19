import { describe, expect, it, vi } from "vitest";
import { parseDomainSnapshot, type EventEnvelope } from "@another-workbench/shared";
import { selectSessionsForConversation } from "../src/store/selectors.js";
import { createRendererStore } from "../src/store/store.js";

const now = "2026-04-21T00:00:00.000Z";

const sessionSnapshot = () =>
  parseDomainSnapshot({
    conversations: [
      {
        conversationId: "conversation-a",
        participantEngineIds: ["agent-a"],
        activeSessionId: "session-a",
        sessionIds: ["session-a"],
        createdAt: now,
        updatedAt: now
      }
    ],
    sessions: [
      {
        sessionId: "session-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        status: "idle",
        title: "Initial session",
        createdAt: now,
        updatedAt: now
      }
    ],
    participants: [
      {
        participantId: "conversation-a:agent-a",
        conversationId: "conversation-a",
        engineId: "agent-a",
        role: "primary",
        capabilities: ["chat"],
        activeSessionIds: ["session-a"]
      }
    ]
  });

const envelope = (eventId: string): EventEnvelope => ({
  eventId,
  cursor: "cursor-1",
  occurredAt: now,
  event: {
    type: "session.created",
    conversationId: "conversation-b",
    sessionId: "session-b",
    engineId: "agent-b",
    status: "idle"
  }
});

describe("renderer store domain replica", () => {
  it("exposes a read model backed by renderer domain state", () => {
    const store = createRendererStore();
    const initialSnapshot = store.getSubscriptionSnapshot();

    expect(store.getRevision()).toBe(0);
    expect(initialSnapshot.revision).toBe(0);
    expect(store.getDomainReadModel()).toBe(initialSnapshot.domain);
    expect(store.getDomainReadModel().listSessions()).toEqual([]);

    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");

    const subscriptionSnapshot = store.getSubscriptionSnapshot();
    expect(subscriptionSnapshot).not.toBe(initialSnapshot);
    expect(subscriptionSnapshot.revision).toBe(1);
    expect(subscriptionSnapshot.domainRevision).toBe(1);
    expect(store.getDomainReadModel()).toBe(initialSnapshot.domain);
    expect(store.getDomainReadModel().getSession("session-a")).toMatchObject({
      sessionId: "session-a",
      title: "Initial session"
    });
    expect(store.getState().entities.sessions).toEqual({});
  });

  it("keeps renderer-only selection revision separate from domain revision", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    const beforeSelection = store.getSubscriptionSnapshot();

    store.dispatch({
      type: "store/setActiveSession",
      sessionId: "session-a"
    });

    const afterSelection = store.getSubscriptionSnapshot();
    expect(afterSelection).not.toBe(beforeSelection);
    expect(afterSelection.revision).toBe(beforeSelection.revision + 1);
    expect(afterSelection.domainRevision).toBe(beforeSelection.domainRevision);
    expect(store.getDomainReadModel().getSession("session-a")).toBeDefined();
  });

  it("projects ingested envelopes only through the domain replica", () => {
    const store = createRendererStore();
    const seenRevisions: number[] = [];
    store.subscribe(() => {
      seenRevisions.push(store.getSubscriptionSnapshot().revision);
    });

    const firstEnvelope = envelope("event-session-b");
    store.ingestEnvelope(firstEnvelope);

    const state = store.getState();
    expect(store.getDomainReadModel().getSession("session-b")).toMatchObject({
      sessionId: "session-b",
      conversationId: "conversation-b"
    });
    expect(state.entities.sessions["session-b"]).toBeUndefined();
    expect(
      store
        .getDomainReadModel()
        .listSessions({ conversationId: "conversation-b" })
        .map((session) => session.sessionId)
    ).toEqual(["session-b"]);
    expect(selectSessionsForConversation(state, "conversation-b")).toEqual([]);
    expect(seenRevisions).toEqual([1]);

    const beforeDuplicate = store.getSubscriptionSnapshot();
    store.ingestEnvelope(firstEnvelope);

    expect(store.getSubscriptionSnapshot()).toBe(beforeDuplicate);
    expect(store.getRevision()).toBe(1);
    expect(store.getDomainReadModel().getRevision()).toBe(1);
  });

  it("uses the replica to replace covered session-window entities", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            activeSessionId: "session-a",
            sessionIds: ["session-a"],
            createdAt: now,
            updatedAt: now
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "running",
            createdAt: now,
            updatedAt: now,
            lastTurnId: "turn-new"
          }
        ],
        turns: [
          {
            turnId: "turn-old",
            sessionId: "session-a",
            status: "completed",
            messageIds: ["message-old"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: [],
            startedAt: "2026-04-21T00:00:00.000Z",
            completedAt: "2026-04-21T00:00:01.000Z"
          },
          {
            turnId: "turn-new",
            sessionId: "session-a",
            status: "streaming",
            messageIds: ["message-new"],
            toolCallIds: ["tool-stale"],
            terminalIds: [],
            approvalRequestIds: [],
            startedAt: "2026-04-21T00:00:02.000Z"
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
            startedAt: "2026-04-21T00:00:00.000Z"
          },
          {
            blockId: "message-new:md",
            messageId: "message-new",
            sessionId: "session-a",
            turnId: "turn-new",
            role: "assistant",
            kind: "markdown",
            text: "stale",
            startedAt: "2026-04-21T00:00:02.000Z"
          }
        ],
        toolCalls: [
          {
            toolCallId: "tool-stale",
            sessionId: "session-a",
            turnId: "turn-new",
            toolName: "shell",
            status: "running",
            startedAt: "2026-04-21T00:00:02.500Z"
          }
        ]
      })
    );

    const state = store.hydrateSessionWindow(
      "session-a",
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            activeSessionId: "session-a",
            sessionIds: ["session-a"],
            createdAt: now,
            updatedAt: "2026-04-21T00:00:03.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-a",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "running",
            createdAt: now,
            updatedAt: "2026-04-21T00:00:03.000Z",
            lastTurnId: "turn-new"
          }
        ],
        turns: [
          {
            turnId: "turn-new",
            sessionId: "session-a",
            status: "streaming",
            messageIds: ["message-new"],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: [],
            startedAt: "2026-04-21T00:00:02.000Z"
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
            startedAt: "2026-04-21T00:00:02.000Z"
          }
        ]
      }),
      "replace",
      "cursor-20"
    );

    expect(store.getDomainReadModel().getTurn("turn-old")).toBeDefined();
    expect(store.getDomainReadModel().getToolCall("tool-stale")).toBeUndefined();
    expect(store.getDomainReadModel().getMessageBlock("message-new:md")?.text).toBe(
      "fresh"
    );
    expect(state.entities.turns["turn-old"]).toBeUndefined();
    expect(state.eventStream.cursorBarrierBySessionId?.["session-a"]).toBe(
      "cursor-20"
    );
  });

  it("notifies only the affected session scope for live events", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-0");
    const sessionA = vi.fn();
    const sessionB = vi.fn();
    store.subscribeSession("session-a", sessionA);
    store.subscribeSession("session-b", sessionB);

    store.ingestEnvelope({
      eventId: "event-a",
      cursor: "cursor-1",
      occurredAt: now,
      event: {
        type: "message.delta",
        sessionId: "session-a",
        turnId: "turn-a",
        messageId: "message-a",
        delta: "hello"
      }
    });

    expect(sessionA).toHaveBeenCalledTimes(1);
    expect(sessionB).not.toHaveBeenCalled();
    expect(store.getDomainReadModel().getMessageBlock("message-a:md")?.text).toBe(
      "hello"
    );
  });

  it("does not commit renderer metadata or domain state for an invalid batch", () => {
    const store = createRendererStore();
    const before = store.getSubscriptionSnapshot();

    expect(() =>
      store.ingestEnvelopes([
        {
          eventId: "event-valid",
          cursor: "cursor-1",
          occurredAt: now,
          event: {
            type: "session.created",
            conversationId: "conversation-a",
            sessionId: "session-a",
            engineId: "agent-a",
            status: "idle"
          }
        },
        {
          eventId: "event-invalid",
          cursor: "cursor-2",
          occurredAt: now,
          event: {
            type: "session.created",
            conversationId: "conversation-a",
            sessionId: "session-b",
            engineId: "agent-a",
            status: "idle",
            relation: {
              relationId: "relation-cycle",
              parentSessionId: "session-b",
              childSessionId: "session-b",
              relationType: "subagent",
              createdAt: now
            }
          }
        }
      ])
    ).toThrow(/cycle/);

    expect(store.getSubscriptionSnapshot()).toBe(before);
    expect(store.getState().eventStream.lastCursor).toBeUndefined();
    expect(store.getDomainReadModel().listSessions({ includeArchived: true })).toEqual(
      []
    );
  });

  it("does not partially commit state when scoped window validation fails", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(sessionSnapshot(), "cursor-1");
    const before = store.getSubscriptionSnapshot();

    expect(() =>
      store.hydrateSessionWindow(
        "session-a",
        parseDomainSnapshot({
          conversations: [
            {
              conversationId: "conversation-b",
              participantEngineIds: ["agent-b"],
              activeSessionId: "session-b",
              sessionIds: ["session-b"],
              createdAt: now,
              updatedAt: now
            }
          ],
          sessions: [
            {
              sessionId: "session-b",
              conversationId: "conversation-b",
              engineId: "agent-b",
              status: "idle",
              createdAt: now,
              updatedAt: now
            }
          ]
        }),
        "replace",
        "cursor-2"
      )
    ).toThrow(/outside merge scope/);

    expect(store.getSubscriptionSnapshot()).toBe(before);
    expect(store.getState().eventStream.lastCursor).toBe("cursor-1");
    expect(store.getDomainReadModel().getSession("session-a")).toBeDefined();
    expect(store.getDomainReadModel().getSession("session-b")).toBeUndefined();
  });
});
