import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@another-workbench/shared";
import { DomainService } from "../src/domain-service.js";

describe("DomainService", () => {
  it("creates sessions and projects participant, session, and conversation state", () => {
    const publishedEvents: RuntimeEvent[] = [];
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:00:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat", "terminal"],
      publishRuntimeEvent: (event) => {
        publishedEvents.push(event);
      }
    });

    const session = service.createSession({
      conversationId: "conversation-1",
      engineId: "codex",
      workspaceId: "workspace-1",
      metadata: {
        source: "test"
      }
    });

    expect(session).toMatchObject({
      sessionId: "session-1",
      conversationId: "conversation-1",
      engineId: "codex",
      metadata: {
        source: "test"
      }
    });
    expect(service.getSnapshot()).toMatchObject({
      conversations: [
        expect.objectContaining({
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          activeSessionId: "session-1"
        })
      ],
      sessions: [
        expect.objectContaining({
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex"
        })
      ],
      participants: [
        expect.objectContaining({
          conversationId: "conversation-1",
          engineId: "codex",
          activeSessionIds: ["session-1"]
        })
      ]
    });
    expect(publishedEvents.map((event) => event.type)).toEqual([
      "participant.updated",
      "session.created",
      "conversation.updated"
    ]);
  });

  it("uses the domain replica for session list/get/archive/resume/dispose state", () => {
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:03:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-domain-owner",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {}
    });

    const created = service.createSession({
      conversationId: "conversation-domain-owner",
      engineId: "codex",
      metadata: {
        cwd: "I:/workspace/project"
      }
    });

    expect(service.getSession(created.sessionId)).toMatchObject({
      sessionId: "session-domain-owner",
      metadata: {
        cwd: "I:/workspace/project"
      }
    });
    expect(service.listSessions()).toHaveLength(1);

    const archived = service.archiveSession(created.sessionId);
    expect(archived.archivedAt).toBeDefined();
    expect(service.listSessions()).toEqual([]);
    expect(service.listSessions({ includeArchived: true })).toHaveLength(1);

    const resumed = service.resumeSession(created.sessionId);
    expect(resumed.archivedAt).toBeUndefined();
    expect(service.listSessions()).toEqual([
      expect.objectContaining({
        sessionId: created.sessionId
      })
    ]);

    expect(service.disposeSession(created.sessionId)).toBe(true);
    expect(service.getSession(created.sessionId)).toBeUndefined();
    expect(service.listSessions({ includeArchived: true })).toEqual([]);
  });

  it("hydrates discovered sessions into the same canonical session store", () => {
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:04:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-hydrated",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat", "terminal"],
      publishRuntimeEvent: () => {}
    });
    service.createSession({
      conversationId: "conversation-hydrated",
      engineId: "codex",
      workspaceId: "workspace-hydrated"
    });
    service.commitAcceptedUserMessage(
      {
        type: "sendUserMessage",
        sessionId: "session-hydrated",
        messageId: "local-user-message",
        content: "hello",
        attachments: []
      },
      "turn-hydrated"
    );

    const hydrated = service.hydrateDiscoveredSession({
      workspaceId: "workspace-hydrated",
      conversation: {
        conversationId: "conversation-hydrated",
        workspaceId: "workspace-hydrated",
        participantEngineIds: ["codex"],
        activeSessionId: "session-hydrated",
        sessionIds: ["session-hydrated"],
        createdAt: "2026-04-19T00:00:00Z",
        updatedAt: "2026-04-19T00:01:00Z"
      },
      session: {
        sessionId: "session-hydrated",
        conversationId: "conversation-hydrated",
        engineId: "codex",
        status: "idle",
        title: "Hydrated session",
        createdAt: "2026-04-19T00:00:00Z",
        updatedAt: "2026-04-19T00:01:00Z",
        metadata: {
          providerSessionId: "thread-hydrated"
        }
      },
      turns: [
        {
          turnId: "turn-hydrated",
          sessionId: "session-hydrated",
          status: "completed",
          finishReason: "completed",
          startedAt: "2026-04-19T00:00:10Z",
          completedAt: "2026-04-19T00:00:20Z",
          messageIds: ["hydrated:session-hydrated:provider-user-message"],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: [],
          interactionRequestIds: []
        }
      ],
      messageBlocks: [
        {
          blockId: "hydrated:session-hydrated:provider-user-message:md",
          messageId: "hydrated:session-hydrated:provider-user-message",
          sessionId: "session-hydrated",
          turnId: "turn-hydrated",
          role: "user",
          kind: "markdown",
          text: "hello",
          startedAt: "2026-04-19T00:00:10Z",
          completedAt: "2026-04-19T00:00:10Z"
        }
      ],
      toolCalls: [],
      terminalStreams: [],
      sessionRelations: []
    });

    expect(hydrated.sessionId).toBe("session-hydrated");
    expect(service.getSession("session-hydrated")).toMatchObject({
      title: "Hydrated session",
      metadata: {
        providerSessionId: "thread-hydrated"
      }
    });
    expect(service.listSessions({ conversationId: "conversation-hydrated" })).toEqual([
      expect.objectContaining({
        sessionId: "session-hydrated"
      })
    ]);
    const snapshot = service.getSnapshot();
    expect(snapshot.turns[0]?.messageIds).toEqual([
      "hydrated:session-hydrated:provider-user-message"
    ]);
    expect(snapshot.messageBlocks.filter((block) => block.role === "user")).toEqual([
      expect.objectContaining({
        messageId: "hydrated:session-hydrated:provider-user-message",
        text: "hello"
      })
    ]);
  });

  it("marks unread completed when a turn finishes", () => {
    const markSessionUnreadCompleted = vi.fn();
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:01:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {},
      markSessionUnreadCompleted
    });

    service.createSession({
      conversationId: "conversation-1",
      engineId: "codex"
    });
    service.ingestRuntimeEvent({
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    });
    service.ingestRuntimeEvent({
      type: "turn.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      finishReason: "completed"
    });

    expect(markSessionUnreadCompleted).toHaveBeenCalledWith("session-1");
    expect(service.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        status: "idle",
        lastTurnId: "turn-1"
      })
    ]);
  });

  it("appends steer messages to the active turn without creating a new turn", () => {
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:02:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      assertEngineRegistered: vi.fn(),
      resolveEngineCapabilities: () => ["chat"],
      publishRuntimeEvent: () => {}
    });

    service.createSession({
      conversationId: "conversation-1",
      engineId: "codex"
    });
    service.ingestRuntimeEvent({
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    });

    service.commitSteerUserMessage({
      type: "steerTurn",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-steer-1",
      content: "Please focus on the diagnostics failure.",
      attachments: []
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        messageIds: ["message-steer-1"]
      })
    ]);
    expect(snapshot.messageBlocks).toEqual([
      expect.objectContaining({
        messageId: "message-steer-1",
        text: "Please focus on the diagnostics failure."
      })
    ]);
  });
});
