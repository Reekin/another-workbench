import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";

const createNowProvider = () => {
  let tick = 0;
  return () => `2026-04-17T00:00:0${tick++}.000Z`;
};

describe("SessionManager", () => {
  it("manages multiple sessions without single-session assumptions", () => {
    let sequence = 0;
    const manager = new SessionManager({
      now: createNowProvider(),
      createSessionId: () => `session-${sequence++}`
    });

    const sessionA = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-a"
    });
    const sessionB = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-b"
    });

    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
    const sessions = manager.listSessions();
    expect(sessions.map((session) => session.sessionId)).toContain(sessionA.sessionId);
    expect(sessions.map((session) => session.sessionId)).toContain(sessionB.sessionId);
  });

  it("archives and resumes sessions while preserving per-session state", () => {
    const manager = new SessionManager({
      now: createNowProvider(),
      createSessionId: () => "session-a"
    });

    const created = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-a",
      status: "completed"
    });

    const archived = manager.archiveSession(created.sessionId);
    expect(archived.archivedAt).toBeDefined();
    expect(manager.listSessions()).toHaveLength(0);
    expect(manager.listSessions({ includeArchived: true })).toHaveLength(1);

    const resumed = manager.resumeSession(created.sessionId);
    expect(resumed.archivedAt).toBeUndefined();
    expect(resumed.status).toBe("idle");
    expect(manager.listSessions()).toHaveLength(1);
  });

  it("supports runtime binding lifecycle per session", () => {
    const manager = new SessionManager({
      now: createNowProvider(),
      createSessionId: () => "session-a"
    });
    const session = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-a"
    });

    manager.bindRuntime(session.sessionId, {
      runtimeId: "runtime-a",
      handle: { processId: 1001 },
      attachedAt: "2026-04-17T00:00:10.000Z"
    });
    expect(manager.getRuntimeBinding(session.sessionId)?.runtimeId).toBe("runtime-a");

    const removed = manager.disposeSession(session.sessionId);
    expect(removed).toBe(true);
    expect(manager.getRuntimeBinding(session.sessionId)).toBeUndefined();
    expect(manager.getSession(session.sessionId)).toBeUndefined();
  });

  it("throws when binding runtime to a missing session", () => {
    const manager = new SessionManager({
      now: createNowProvider()
    });

    expect(() =>
      manager.bindRuntime("missing-session", {
        handle: {},
        attachedAt: "2026-04-17T00:00:10.000Z"
      })
    ).toThrow("Session not found: missing-session");
  });

  it("enforces runtimeId uniqueness across sessions and keeps reverse lookup", () => {
    let sequence = 0;
    const manager = new SessionManager({
      now: createNowProvider(),
      createSessionId: () => `session-${++sequence}`
    });

    const sessionA = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-a"
    });
    const sessionB = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-b"
    });

    manager.bindRuntime(sessionA.sessionId, {
      runtimeId: "runtime-shared",
      handle: { pid: 101 },
      attachedAt: "2026-04-17T00:00:10.000Z"
    });
    expect(manager.getSessionIdByRuntimeId("runtime-shared")).toBe(sessionA.sessionId);

    expect(() =>
      manager.bindRuntime(sessionB.sessionId, {
        runtimeId: "runtime-shared",
        handle: { pid: 102 },
        attachedAt: "2026-04-17T00:00:11.000Z"
      })
    ).toThrow("Runtime runtime-shared is already bound");
  });

  it("resolves runtime route for concurrent event routing", () => {
    const manager = new SessionManager({
      now: createNowProvider(),
      createSessionId: () => "session-a"
    });
    const session = manager.createSession({
      conversationId: "conversation-a",
      agentId: "agent-a"
    });

    manager.bindRuntime(session.sessionId, {
      runtimeId: "runtime-a",
      handle: { pid: 1001 },
      attachedAt: "2026-04-17T00:00:10.000Z"
    });

    expect(
      manager.resolveRuntimeRoute({
        runtimeId: "runtime-a",
        eventSessionId: "session-a"
      })
    ).toEqual({
      accepted: true,
      sessionId: "session-a"
    });

    expect(
      manager.resolveRuntimeRoute({
        runtimeId: "runtime-a",
        eventSessionId: "session-b"
      })
    ).toEqual({
      accepted: false,
      reason: "session_mismatch",
      sessionId: "session-a"
    });

    expect(
      manager.resolveRuntimeRoute({
        runtimeId: "runtime-missing"
      })
    ).toEqual({
      accepted: false,
      reason: "runtime_not_bound"
    });
  });
});
