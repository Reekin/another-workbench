import { describe, expect, it } from "vitest";
import { DomainProjector } from "../src/domain-projector.js";
import { DomainStore } from "../src/domain-store.js";

describe("DomainProjector", () => {
  it("projects sessions, relations, participants, and filtered snapshots", () => {
    const store = new DomainStore();
    const projector = new DomainProjector({ store });

    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-1",
        agentId: "agent-a",
        status: "idle"
      },
      "2026-04-18T00:00:00.000Z"
    );
    projector.apply(
      {
        type: "participant.updated",
        conversationId: "conversation-a",
        participantId: "participant-conversation-a-agent-a",
        agentId: "agent-a",
        role: "primary",
        capabilities: ["chat"]
      },
      "2026-04-18T00:00:01.000Z"
    );
    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-2",
        agentId: "agent-a",
        status: "running",
        relation: {
          relationId: "relation-1",
          parentSessionId: "session-1",
          childSessionId: "session-2",
          relationType: "fork",
          createdAt: "2026-04-18T00:00:02.000Z"
        }
      },
      "2026-04-18T00:00:02.000Z"
    );
    projector.apply(
      {
        type: "session.archived",
        conversationId: "conversation-a",
        sessionId: "session-2",
        archivedAt: "2026-04-18T00:00:03.000Z"
      },
      "2026-04-18T00:00:03.000Z"
    );

    expect(store.getConversation("conversation-a")).toMatchObject({
      activeSessionId: "session-1",
      participantAgentIds: ["agent-a"],
      sessionIds: ["session-1", "session-2"]
    });
    expect(store.getSessionParent("session-2")).toBe("session-1");
    expect(store.getSessionChildren("session-1")).toEqual(["session-2"]);
    expect(store.getParticipant("participant-conversation-a-agent-a")).toMatchObject({
      activeSessionIds: ["session-1"]
    });

    const conversationSnapshot = store.getConversationSnapshot("conversation-a");
    expect(conversationSnapshot.sessions.map((session) => session.sessionId)).toEqual([
      "session-2",
      "session-1"
    ]);
    expect(conversationSnapshot.sessionRelations).toHaveLength(1);

    const sessionSnapshot = store.getSessionSnapshot("session-1");
    expect(sessionSnapshot.sessions.map((session) => session.sessionId)).toEqual([
      "session-1"
    ]);
    expect(sessionSnapshot.sessionRelations).toEqual([
      expect.objectContaining({
        relationId: "relation-1"
      })
    ]);
  });

  it("projects message, tool, terminal, and turn state into a stable session snapshot", () => {
    const projector = new DomainProjector();

    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-1",
        agentId: "agent-a",
        status: "idle"
      },
      "2026-04-18T00:01:00.000Z"
    );
    projector.apply(
      {
        type: "turn.started",
        sessionId: "session-1",
        turnId: "turn-1"
      },
      "2026-04-18T00:01:01.000Z"
    );
    projector.apply(
      {
        type: "message.started",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:02.000Z"
    );
    projector.apply(
      {
        type: "message.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "draft",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:03.000Z"
    );
    projector.apply(
      {
        type: "message.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        finalText: "final answer",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:04.000Z"
    );
    projector.apply(
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolName: "exec_command",
        inputSummary: "ls",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:05.000Z"
    );
    projector.apply(
      {
        type: "tool.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        delta: "stdout",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:06.000Z"
    );
    projector.apply(
      {
        type: "tool.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        status: "completed",
        outputSummary: "listed files",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:07.000Z"
    );
    projector.apply(
      {
        type: "terminal.started",
        sessionId: "session-1",
        turnId: "turn-1",
        terminalId: "terminal-1",
        toolCallId: "tool-1",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:08.000Z"
    );
    projector.apply(
      {
        type: "terminal.output",
        sessionId: "session-1",
        turnId: "turn-1",
        terminalId: "terminal-1",
        chunk: "line 1\n",
        agentId: "agent-a"
      },
      "2026-04-18T00:01:09.000Z"
    );
    projector.apply(
      {
        type: "terminal.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        terminalId: "terminal-1",
        exitCode: 1,
        agentId: "agent-a"
      },
      "2026-04-18T00:01:10.000Z"
    );
    projector.apply(
      {
        type: "turn.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        finishReason: "completed"
      },
      "2026-04-18T00:01:11.000Z"
    );

    const sessionSnapshot = projector.store.getSessionSnapshot("session-1");
    expect(sessionSnapshot.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        status: "completed",
        messageIds: ["message-1"],
        toolCallIds: ["tool-1"],
        terminalIds: ["terminal-1"]
      })
    ]);
    expect(sessionSnapshot.messageBlocks).toEqual([
      expect.objectContaining({
        blockId: "message-1:md",
        text: "final answer"
      })
    ]);
    expect(sessionSnapshot.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        status: "completed",
        inputSummary: "ls",
        outputSummary: "listed files"
      })
    ]);
    expect(sessionSnapshot.terminalStreams).toEqual([
      expect.objectContaining({
        terminalId: "terminal-1",
        toolCallId: "tool-1",
        outputText: "line 1\n",
        status: "failed",
        exitCode: 1
      })
    ]);
    expect(projector.store.getTurn("turn-1")).not.toHaveProperty("unifiedDiff");
    expect(projector.store.getSession("session-1")).toMatchObject({
      status: "idle",
      lastTurnId: "turn-1"
    });
  });

  it("keeps awaiting_approval until another runtime event changes session status", () => {
    const projector = new DomainProjector();

    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-1",
        agentId: "agent-a",
        status: "idle"
      },
      "2026-04-18T00:02:00.000Z"
    );
    projector.apply(
      {
        type: "approval.requested",
        sessionId: "session-1",
        turnId: "turn-1",
        requestId: "approval-1",
        approvalKind: "tool",
        title: "Need approval",
        agentId: "agent-a"
      },
      "2026-04-18T00:02:01.000Z"
    );
    projector.apply(
      {
        type: "approval.resolved",
        sessionId: "session-1",
        turnId: "turn-1",
        requestId: "approval-1",
        action: "approve",
        agentId: "agent-a"
      },
      "2026-04-18T00:02:02.000Z"
    );

    expect(projector.store.getApprovalRequest("approval-1")).toMatchObject({
      status: "approved",
      resolvedAt: "2026-04-18T00:02:02.000Z"
    });
    expect(projector.store.getSession("session-1")).toMatchObject({
      status: "awaiting_approval"
    });

    projector.apply(
      {
        type: "session.updated",
        conversationId: "conversation-a",
        sessionId: "session-1",
        status: "running"
      },
      "2026-04-18T00:02:03.000Z"
    );

    expect(projector.store.getSession("session-1")).toMatchObject({
      status: "running"
    });
  });

  it("backfills a participant from session lifecycle events when no participant event exists yet", () => {
    const projector = new DomainProjector();

    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-1",
        agentId: "agent-a",
        status: "idle"
      },
      "2026-04-18T00:02:30.000Z"
    );
    projector.apply(
      {
        type: "session.updated",
        conversationId: "conversation-a",
        sessionId: "session-1",
        status: "running"
      },
      "2026-04-18T00:02:31.000Z"
    );

    expect(projector.store.getParticipant("participant-conversation-a-agent-a")).toMatchObject({
      agentId: "agent-a",
      conversationId: "conversation-a",
      role: "primary",
      capabilities: [],
      activeSessionIds: ["session-1"]
    });
    expect(projector.store.getConversation("conversation-a")).toMatchObject({
      participantAgentIds: ["agent-a"]
    });
  });

  it("converts runtime errors into visible failed turns and cascades disposal cleanup", () => {
    const projector = new DomainProjector();

    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-1",
        agentId: "agent-a",
        status: "idle"
      },
      "2026-04-18T00:03:00.000Z"
    );
    projector.apply(
      {
        type: "session.created",
        conversationId: "conversation-a",
        sessionId: "session-2",
        agentId: "agent-a",
        status: "idle",
        relation: {
          relationId: "relation-2",
          parentSessionId: "session-1",
          childSessionId: "session-2",
          relationType: "fork",
          createdAt: "2026-04-18T00:03:01.000Z"
        }
      },
      "2026-04-18T00:03:01.000Z"
    );
    projector.apply(
      {
        type: "turn.started",
        sessionId: "session-1",
        turnId: "turn-error"
      },
      "2026-04-18T00:03:02.000Z"
    );
    projector.apply(
      {
        type: "message.started",
        sessionId: "session-1",
        turnId: "turn-error",
        messageId: "message-error",
        role: "assistant",
        agentId: "agent-a"
      },
      "2026-04-18T00:03:03.000Z"
    );
    projector.apply(
      {
        type: "tool.started",
        sessionId: "session-1",
        turnId: "turn-error",
        toolCallId: "tool-error",
        toolName: "exec_command",
        agentId: "agent-a"
      },
      "2026-04-18T00:03:04.000Z"
    );
    projector.apply(
      {
        type: "terminal.started",
        sessionId: "session-1",
        turnId: "turn-error",
        terminalId: "terminal-error",
        toolCallId: "tool-error",
        agentId: "agent-a"
      },
      "2026-04-18T00:03:05.000Z"
    );
    projector.apply(
      {
        type: "approval.requested",
        sessionId: "session-1",
        turnId: "turn-error",
        requestId: "approval-error",
        approvalKind: "tool",
        title: "Need approval",
        agentId: "agent-a"
      },
      "2026-04-18T00:03:06.000Z"
    );
    projector.apply(
      {
        type: "runtime.error",
        sessionId: "session-1",
        turnId: "turn-error",
        code: "RUNTIME_FAIL",
        message: "Boom",
        recoverable: false
      },
      "2026-04-18T00:03:07.000Z"
    );

    expect(projector.store.getTurn("turn-error")).toMatchObject({
      status: "completed",
      finishReason: "failed"
    });
    expect(projector.store.getMessageBlock("message-error:md")).toMatchObject({
      role: "system",
      text: "Runtime error (RUNTIME_FAIL): Boom"
    });
    expect(projector.store.getSession("session-1")).toMatchObject({
      status: "error",
      lastTurnId: "turn-error"
    });

    projector.apply(
      {
        type: "session.disposed",
        conversationId: "conversation-a",
        sessionId: "session-1",
        disposedAt: "2026-04-18T00:03:08.000Z"
      },
      "2026-04-18T00:03:08.000Z"
    );

    expect(projector.store.getSession("session-1")).toBeUndefined();
    expect(projector.store.getTurn("turn-error")).toBeUndefined();
    expect(projector.store.getMessageBlock("message-error:md")).toBeUndefined();
    expect(projector.store.getToolCall("tool-error")).toBeUndefined();
    expect(projector.store.getTerminalStream("terminal-error")).toBeUndefined();
    expect(projector.store.getApprovalRequest("approval-error")).toBeUndefined();
    expect(projector.store.getSessionRelation("relation-2")).toBeUndefined();
    expect(projector.store.getConversation("conversation-a")).toMatchObject({
      activeSessionId: "session-2",
      sessionIds: ["session-2"]
    });
  });
});
