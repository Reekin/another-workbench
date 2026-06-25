import { describe, expect, it } from "vitest";
import { DomainReplica } from "../src/domain-replica.js";

const now = "2026-04-21T00:00:00.000Z";

describe("DomainReplica", () => {
  it("applies runtime events and exposes read selectors", () => {
    const replica = new DomainReplica({
      now: () => now
    });

    replica.apply({
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-a",
      engineId: "agent-a",
      status: "idle"
    });

    expect(replica.getRevision()).toBe(1);
    expect(replica.readModel.getRevision()).toBe(1);
    expect(replica.readModel.getSession("session-a")).toMatchObject({
      sessionId: "session-a",
      conversationId: "conversation-a",
      engineId: "agent-a"
    });
    expect(replica.readModel.getConversationSnapshot("conversation-a")).toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId: "conversation-a"
        })
      ],
      sessions: [
        expect.objectContaining({
          sessionId: "session-a"
        })
      ],
      participants: [
        expect.objectContaining({
          engineId: "agent-a",
          activeSessionIds: ["session-a"]
        })
      ]
    });
    expect("apply" in replica.readModel).toBe(false);
    expect("replaceSnapshot" in replica.readModel).toBe(false);
  });

  it("applies envelopes with their occurrence time", () => {
    const replica = new DomainReplica();

    replica.applyEnvelope({
      occurredAt: "2026-04-21T00:02:00.000Z",
      event: {
        type: "turn.started",
        sessionId: "session-a",
        turnId: "turn-a"
      }
    });

    expect(replica.readModel.getTurn("turn-a")).toMatchObject({
      turnId: "turn-a",
      startedAt: "2026-04-21T00:02:00.000Z"
    });
  });

  it("replaces and merges snapshots through the same read model", () => {
    const replica = new DomainReplica();

    replica.replaceSnapshot({
      conversations: [
        {
          conversationId: "conversation-a",
          participantEngineIds: ["agent-a"],
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
          createdAt: now,
          updatedAt: now
        }
      ],
      turns: [],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: []
    });

    replica.mergeSnapshot(
      {
        conversations: [
          {
            conversationId: "conversation-a",
            participantEngineIds: ["agent-a"],
            sessionIds: ["session-b"],
            createdAt: now,
            updatedAt: now
          }
        ],
        sessions: [
          {
            sessionId: "session-b",
            conversationId: "conversation-a",
            engineId: "agent-a",
            status: "idle",
            createdAt: now,
            updatedAt: now
          }
        ],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        runtimeInteractions: [],
        participants: [],
        threadGoals: [],
        sessionRelations: []
      },
      { scope: { conversationId: "conversation-a" } }
    );

    expect(replica.getRevision()).toBe(2);
    expect(
      replica.readModel
        .listSessions({ includeArchived: true })
        .map((session) => session.sessionId)
        .sort()
    ).toEqual(["session-a", "session-b"]);
    expect(replica.readModel.resolveConversationIdBySessionId("session-b")).toBe(
      "conversation-a"
    );
  });

  it("clears read state on dispose and rejects later mutations", () => {
    const replica = new DomainReplica();

    replica.apply({
      type: "session.created",
      conversationId: "conversation-a",
      sessionId: "session-a",
      engineId: "agent-a",
      status: "idle"
    });
    replica.dispose();

    expect(replica.isDisposed()).toBe(true);
    expect(replica.readModel.isDisposed()).toBe(true);
    expect(replica.readModel.getSnapshot().sessions).toEqual([]);
    expect(replica.getRevision()).toBe(2);
    expect(() =>
      replica.apply({
        type: "session.updated",
        conversationId: "conversation-a",
        sessionId: "session-a",
        status: "running"
      })
    ).toThrow("DomainReplica has been disposed");
  });
});
