import { describe, expect, it } from "vitest";
import { buildSessionWindowSnapshot } from "../src/session-window.js";

const conversation = {
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  participantEngineIds: ["codex"],
  activeSessionId: "session-1",
  sessionIds: ["session-1"],
  createdAt: "2026-04-19T00:00:00.000Z",
  updatedAt: "2026-04-19T00:05:10.000Z"
};

const session = {
  sessionId: "session-1",
  conversationId: "conversation-1",
  engineId: "codex",
  status: "idle" as const,
  createdAt: "2026-04-19T00:00:00.000Z",
  updatedAt: "2026-04-19T00:05:10.000Z"
};

const participants = [
  {
    participantId: "participant-codex",
    conversationId: "conversation-1",
    engineId: "codex",
    role: "primary" as const,
    capabilities: [],
    activeSessionIds: ["session-1"],
    joinedAt: "2026-04-19T00:00:00.000Z"
  }
];

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
    approvalRequestIds: [],
    interactionRequestIds: index === 2 ? ["interaction-2-ref"] : []
  }));

describe("buildSessionWindowSnapshot", () => {
  it("anchors the window around the requested turn", () => {
    const page = buildSessionWindowSnapshot({
      sessionId: "session-1",
      conversation,
      session,
      turns: buildTurns(),
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [],
      participants,
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

  it("keeps window turn interactions and pending session-scoped interactions", () => {
    const page = buildSessionWindowSnapshot({
      sessionId: "session-1",
      conversation,
      session,
      turns: buildTurns(),
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [
        {
          requestId: "interaction-2",
          sessionId: "session-1",
          turnId: "turn-2",
          interactionKind: "tool_user_input",
          status: "pending",
          title: "Need input",
          payload: {},
          requestedAt: "2026-04-19T00:02:05.000Z"
        },
        {
          requestId: "interaction-2-ref",
          sessionId: "session-1",
          turnId: "turn-99",
          interactionKind: "tool_user_input",
          status: "pending",
          title: "Referenced by window turn",
          payload: {},
          requestedAt: "2026-04-19T00:02:06.000Z"
        },
        {
          requestId: "interaction-session",
          sessionId: "session-1",
          interactionKind: "mcp_elicitation",
          status: "pending",
          title: "Out-of-band elicitation",
          payload: {},
          requestedAt: "2026-04-19T00:02:07.000Z"
        },
        {
          requestId: "interaction-resolved-session",
          sessionId: "session-1",
          interactionKind: "mcp_elicitation",
          status: "resolved",
          title: "Resolved session interaction",
          payload: {},
          requestedAt: "2026-04-19T00:02:08.000Z",
          resolvedAt: "2026-04-19T00:02:09.000Z"
        },
        {
          requestId: "interaction-5",
          sessionId: "session-1",
          turnId: "turn-5",
          interactionKind: "tool_user_input",
          status: "pending",
          title: "Outside window",
          payload: {},
          requestedAt: "2026-04-19T00:05:05.000Z"
        },
        {
          requestId: "interaction-other-session",
          sessionId: "session-2",
          interactionKind: "mcp_elicitation",
          status: "pending",
          title: "Other session",
          payload: {},
          requestedAt: "2026-04-19T00:02:10.000Z"
        }
      ],
      participants,
      sessionRelations: [],
      limit: 2,
      anchorTurnId: "turn-2"
    });

    expect(
      (page.snapshot.runtimeInteractions ?? []).map(
        (interaction) => interaction.requestId
      )
    ).toEqual(["interaction-2", "interaction-2-ref", "interaction-session"]);
  });

  it("keeps pending session-scoped interactions when the session has no turns", () => {
    const page = buildSessionWindowSnapshot({
      sessionId: "session-1",
      conversation,
      session,
      turns: [],
      messageBlocks: [],
      toolCalls: [],
      terminalStreams: [],
      approvalRequests: [],
      runtimeInteractions: [
        {
          requestId: "interaction-session",
          sessionId: "session-1",
          interactionKind: "mcp_elicitation",
          status: "pending",
          title: "Out-of-band elicitation",
          payload: {},
          requestedAt: "2026-04-19T00:00:05.000Z"
        }
      ],
      participants,
      sessionRelations: [],
      limit: 2
    });

    expect(page.snapshot.runtimeInteractions?.map((item) => item.requestId)).toEqual([
      "interaction-session"
    ]);
  });
});
