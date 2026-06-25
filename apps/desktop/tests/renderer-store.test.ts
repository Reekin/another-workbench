import { describe, expect, it } from "vitest";
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
    expect(store.getDomainReadModel().getSnapshot().sessions).toEqual(
      Object.values(store.getState().entities.sessions)
    );
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

  it("syncs ingested envelopes to the read model without changing legacy selector results", () => {
    const store = createRendererStore();
    const seenRevisions: number[] = [];
    store.subscribe(() => {
      seenRevisions.push(store.getSubscriptionSnapshot().revision);
    });

    const firstEnvelope = envelope("event-session-b");
    store.ingestEnvelope(firstEnvelope);

    const state = store.getState();
    expect(store.getDomainReadModel().getSession("session-b")).toEqual(
      state.entities.sessions["session-b"]
    );
    expect(
      store
        .getDomainReadModel()
        .listSessions({ conversationId: "conversation-b" })
        .map((session) => session.sessionId)
    ).toEqual(
      selectSessionsForConversation(state, "conversation-b").map(
        (session) => session.sessionId
      )
    );
    expect(seenRevisions).toEqual([1]);

    const beforeDuplicate = store.getSubscriptionSnapshot();
    store.ingestEnvelope(firstEnvelope);

    expect(store.getSubscriptionSnapshot()).toBe(beforeDuplicate);
    expect(store.getRevision()).toBe(1);
    expect(store.getDomainReadModel().getRevision()).toBe(1);
  });
});
