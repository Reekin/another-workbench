import { describe, expect, it } from "vitest";
import type {
  ChatSession,
  Conversation,
  DomainSnapshot,
  SessionRelation,
  ThreadGoal,
  Turn
} from "@another-workbench/shared";
import { DomainStore, DomainStoreRelationError } from "../src/domain-store.js";

const now = "2026-04-18T00:00:00.000Z";

const conversation = (conversationId: string): Conversation => ({
  conversationId,
  participantEngineIds: [],
  sessionIds: [],
  createdAt: now,
  updatedAt: now
});

const session = (
  sessionId: string,
  conversationId = "conversation-a"
): ChatSession => ({
  sessionId,
  conversationId,
  engineId: "agent-a",
  status: "idle",
  createdAt: now,
  updatedAt: now
});

const relation = (
  relationId: string,
  parentSessionId: string,
  childSessionId: string
): SessionRelation => ({
  relationId,
  parentSessionId,
  childSessionId,
  relationType: "fork",
  createdAt: now
});

const turn = (turnId: string, sessionId = "session-a"): Turn => ({
  turnId,
  sessionId,
  status: "started",
  startedAt: now,
  messageIds: ["message-a"],
  toolCallIds: [],
  terminalIds: [],
  approvalRequestIds: [],
  interactionRequestIds: []
});

const goal = (sessionId: string, updatedAt: number): ThreadGoal => ({
  sessionId,
  threadId: `thread-${sessionId}`,
  objective: `Goal for ${sessionId}`,
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: updatedAt,
  updatedAt
});

const expectRelationError = (
  fn: () => unknown,
  code: DomainStoreRelationError["code"]
): void => {
  try {
    fn();
    throw new Error("Expected relation invariant error");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainStoreRelationError);
    expect((error as DomainStoreRelationError).code).toBe(code);
  }
};

describe("DomainStore", () => {
  it("preserves the current snapshot when replaceSnapshot fails relation validation", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-live"));
    store.upsertSession(session("session-live", "conversation-live"));
    const baseline = store.getSnapshot();

    const invalidSnapshot: DomainSnapshot = {
      conversations: [conversation("conversation-a")],
      sessions: [
        session("root"),
        session("child"),
        session("grandchild")
      ],
      turns: [],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants: [],
      threadGoals: [],
      sessionRelations: [
        relation("relation-root-child", "root", "child"),
        relation("relation-child-grandchild", "child", "grandchild"),
        relation("relation-cycle", "grandchild", "root")
      ]
    };

    expectRelationError(
      () => store.replaceSnapshot(invalidSnapshot),
      "cycle"
    );
    expect(store.getSnapshot()).toEqual(baseline);
  });

  it("preserves the current snapshot when replaceSnapshot fails parsing", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-live"));
    store.upsertSession(session("session-live", "conversation-live"));
    const baseline = store.getSnapshot();

    expect(() =>
      store.replaceSnapshot({
        ...baseline,
        sessions: [
          {
            ...session("session-invalid", "conversation-live"),
            status: "not-a-status"
          }
        ]
      })
    ).toThrow();
    expect(store.getSnapshot()).toEqual(baseline);
  });

  it("preserves the current snapshot when mergeSnapshot fails validation", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertSession(session("parent-a"));
    store.upsertSession(session("parent-b"));
    store.upsertSession(session("child-a"));
    store.upsertSessionRelation(relation("relation-a", "parent-a", "child-a"));
    const baseline = store.getSnapshot();

    expectRelationError(
      () =>
        store.mergeSnapshot({
          conversations: [],
          sessions: [],
          turns: [],
          messageBlocks: [],
          toolCalls: [],
          terminalStreams: [],
          approvalRequests: [],
          runtimeInteractions: [],
          participants: [],
          threadGoals: [],
          sessionRelations: [
            relation("relation-b", "parent-b", "child-a")
          ]
        }),
      "duplicate_structural_parent"
    );
    expect(store.getSnapshot()).toEqual(baseline);
  });

  it("merges session-scoped snapshots without truncating existing conversation state", () => {
    const store = new DomainStore();
    store.upsertConversation({
      ...conversation("conversation-a"),
      sessionIds: ["session-a", "session-b"]
    });
    store.upsertSession(session("session-a"));
    store.upsertSession(session("session-b"));
    store.upsertTurn(turn("turn-existing", "session-a"));

    store.mergeSnapshot(
      {
        conversations: [
          {
            ...conversation("conversation-a"),
            sessionIds: ["session-a"]
          }
        ],
        sessions: [
          {
            ...session("session-a"),
            title: "Merged session"
          }
        ],
        turns: [turn("turn-page", "session-a")],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        runtimeInteractions: [],
        participants: [],
        threadGoals: [],
        sessionRelations: []
      },
      {
        scope: {
          sessionId: "session-a"
        }
      }
    );

    expect(store.getConversation("conversation-a")?.sessionIds).toEqual([
      "session-a",
      "session-b"
    ]);
    expect(store.getSession("session-a")?.title).toBe("Merged session");
    expect(store.listTurns({ sessionId: "session-a" }).map((item) => item.turnId))
      .toEqual(["turn-existing", "turn-page"]);
  });

  it("rejects mergeSnapshot entities outside the requested scope", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertConversation(conversation("conversation-b"));
    store.upsertSession(session("session-a", "conversation-a"));
    store.upsertSession(session("session-b", "conversation-b"));
    const baseline = store.getSnapshot();

    expect(() =>
      store.mergeSnapshot(
        {
          conversations: [],
          sessions: [],
          turns: [turn("turn-outside", "session-b")],
          messageBlocks: [],
          toolCalls: [],
          terminalStreams: [],
          approvalRequests: [],
          runtimeInteractions: [],
          participants: [],
          threadGoals: [],
          sessionRelations: []
        },
        {
          scope: {
            sessionId: "session-a"
          }
        }
      )
    ).toThrow(/outside merge scope/);
    expect(store.getSnapshot()).toEqual(baseline);
  });

  it("rejects duplicate structural parents for one child session", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertSession(session("parent-a"));
    store.upsertSession(session("parent-b"));
    store.upsertSession(session("child-a"));
    store.upsertSessionRelation(relation("relation-a", "parent-a", "child-a"));

    expectRelationError(
      () => store.upsertSessionRelation(relation("relation-b", "parent-b", "child-a")),
      "duplicate_structural_parent"
    );

    expect(store.getSessionParent("child-a")).toBe("parent-a");
    expect(store.getSessionChildren("parent-a")).toEqual(["child-a"]);
    expect(store.getSessionChildren("parent-b")).toEqual([]);
  });

  it("rejects session relation cycles", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertSession(session("root"));
    store.upsertSession(session("child"));
    store.upsertSession(session("grandchild"));
    store.upsertSessionRelation(relation("relation-root-child", "root", "child"));
    store.upsertSessionRelation(
      relation("relation-child-grandchild", "child", "grandchild")
    );

    expectRelationError(
      () => store.upsertSessionRelation(relation("relation-cycle", "grandchild", "root")),
      "cycle"
    );
    expectRelationError(
      () => store.upsertSessionRelation(relation("relation-self", "root", "root")),
      "cycle"
    );

    expect(store.getSessionParent("root")).toBeUndefined();
    expect(store.getSessionParent("grandchild")).toBe("child");
  });

  it("rejects cross-conversation session relations when both sessions are known", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertConversation(conversation("conversation-b"));
    store.upsertSession(session("parent-a", "conversation-a"));
    store.upsertSession(session("child-b", "conversation-b"));

    expectRelationError(
      () => store.upsertSessionRelation(relation("relation-cross", "parent-a", "child-b")),
      "conversation_mismatch"
    );

    expect(store.getSessionParent("child-b")).toBeUndefined();
    expect(store.getSessionChildren("parent-a")).toEqual([]);
  });

  it("rejects session conversation updates that would break known relations", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertConversation(conversation("conversation-b"));
    store.upsertSession(session("parent-a", "conversation-a"));
    store.upsertSession(session("child-a", "conversation-a"));
    store.upsertSessionRelation(relation("relation-a", "parent-a", "child-a"));

    expectRelationError(
      () => store.upsertSession(session("child-a", "conversation-b")),
      "conversation_mismatch"
    );

    expect(store.getSession("child-a")?.conversationId).toBe("conversation-a");
    expect(store.getSessionParent("child-a")).toBe("parent-a");
  });

  it("cleans relation indexes after relation updates and deletes", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertSession(session("parent-a"));
    store.upsertSession(session("parent-b"));
    store.upsertSession(session("child-a"));
    store.upsertSession(session("child-b"));
    store.upsertSessionRelation(relation("relation-a", "parent-a", "child-a"));

    store.upsertSessionRelation(relation("relation-a", "parent-a", "child-b"));
    expect(store.getSessionParent("child-a")).toBeUndefined();
    expect(store.getSessionParent("child-b")).toBe("parent-a");
    expect(store.getSessionChildren("parent-a")).toEqual(["child-b"]);

    store.upsertSessionRelation(relation("relation-a", "parent-b", "child-b"));
    expect(store.getSessionChildren("parent-a")).toEqual([]);
    expect(store.getSessionChildren("parent-b")).toEqual(["child-b"]);

    expect(store.deleteSessionRelation("relation-a")).toBe(true);
    expect(store.getSessionParent("child-b")).toBeUndefined();
    expect(store.getSessionChildren("parent-b")).toEqual([]);
  });

  it("returns defensive copies from getters, lists, and snapshots", () => {
    const store = new DomainStore();
    store.upsertConversation(conversation("conversation-a"));
    store.upsertSession(session("session-a"));
    store.upsertTurn(turn("turn-a"));

    const sessionFromGetter = store.getSession("session-a");
    expect(sessionFromGetter).toBeDefined();
    if (!sessionFromGetter) {
      throw new Error("Expected session-a to exist.");
    }
    sessionFromGetter.status = "error";

    const sessionFromList = store.listSessions({ includeArchived: true })[0];
    sessionFromList.status = "completed";

    const snapshot = store.getSnapshot();
    snapshot.sessions[0].status = "running";
    snapshot.turns[0].messageIds.push("message-poison");

    expect(store.getSession("session-a")?.status).toBe("idle");
    expect(store.listSessions({ includeArchived: true })[0].status).toBe("idle");
    expect(store.getSnapshot().sessions[0].status).toBe("idle");
    expect(store.getTurn("turn-a")?.messageIds).toEqual(["message-a"]);
  });

  it("sorts thread goals with numeric updatedAt semantics", () => {
    const store = new DomainStore();
    store.upsertThreadGoal(goal("session-ten", 10));
    store.upsertThreadGoal(goal("session-two", 2));
    store.upsertThreadGoal(goal("session-one", 1));

    expect(store.listThreadGoals().map((item) => item.sessionId)).toEqual([
      "session-one",
      "session-two",
      "session-ten"
    ]);
  });
});
