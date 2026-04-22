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
      resolveAgentDescriptor: () => ({
        agentId: "codex",
        displayName: "Codex",
        capabilities: ["chat", "terminal"]
      }),
      publishRuntimeEvent: (event) => {
        publishedEvents.push(event);
      }
    });

    const session = service.createSession({
      conversationId: "conversation-1",
      agentId: "codex",
      workspaceId: "workspace-1",
      metadata: {
        source: "test"
      }
    });

    expect(session).toMatchObject({
      sessionId: "session-1",
      conversationId: "conversation-1",
      agentId: "codex",
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
          agentId: "codex"
        })
      ],
      participants: [
        expect.objectContaining({
          conversationId: "conversation-1",
          agentId: "codex",
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

  it("marks unread completed when a turn finishes", () => {
    const markSessionUnreadCompleted = vi.fn();
    const service = new DomainService({
      now: (() => {
        let tick = 0;
        return () => `2026-04-20T00:01:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createSessionId: () => "session-1",
      resolveAgentDescriptor: () => ({
        agentId: "codex",
        displayName: "Codex",
        capabilities: ["chat"]
      }),
      publishRuntimeEvent: () => {},
      markSessionUnreadCompleted
    });

    service.createSession({
      conversationId: "conversation-1",
      agentId: "codex"
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
      resolveAgentDescriptor: () => ({
        agentId: "codex",
        displayName: "Codex",
        capabilities: ["chat"]
      }),
      publishRuntimeEvent: () => {}
    });

    service.createSession({
      conversationId: "conversation-1",
      agentId: "codex"
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
