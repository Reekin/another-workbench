import { describe, expect, it } from "vitest";
import { buildSessionWindowSnapshot } from "../src/session-window.js";

const buildTurns = () =>
  [1, 2, 3, 4, 5].map((index) => ({
    turnId: `turn-${index}`,
    sessionId: "session-1",
    status: "completed" as const,
    finishReason: "completed" as const,
    startedAt: `2026-04-19T00:0${index}:00.000Z`,
    completedAt: `2026-04-19T00:0${index}:10.000Z`,
    messageIds: [],
    toolCallIds: [],
    terminalIds: [],
    approvalRequestIds: []
  }));

describe("buildSessionWindowSnapshot", () => {
  it("anchors the window around the requested turn", () => {
    const page = buildSessionWindowSnapshot({
      sessionId: "session-1",
      conversation: {
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        participantAgentIds: ["codex"],
        activeSessionId: "session-1",
        sessionIds: ["session-1"],
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:05:10.000Z"
      },
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        agentId: "codex",
        status: "idle",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:05:10.000Z"
      },
      turns: buildTurns(),
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      participants: [
        {
          participantId: "participant-codex",
          conversationId: "conversation-1",
          agentId: "codex",
          displayName: "Codex",
          activeSessionIds: ["session-1"],
          joinedAt: "2026-04-19T00:00:00.000Z"
        }
      ],
      sessionRelations: [],
      limit: 2,
      anchorTurnId: "turn-2"
    });

    expect(page.windowStartTurnId).toBe("turn-1");
    expect(page.windowEndTurnId).toBe("turn-2");
    expect(page.snapshot.turns.map((turn) => turn.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(true);
  });
});
