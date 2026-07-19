import { describe, expect, it } from "vitest";
import {
  filterComposerTurnsForChatTree,
  filterTranscriptRowsForChatTree
} from "../src/ui/chat-shell/chat-tree-transcript.js";
import type { TurnTranscriptRow } from "../src/ui/chat-shell/transcript-view-model.js";

const row = (
  turnId: string,
  messageRole: TurnTranscriptRow["messageRole"] = "assistant",
  status: TurnTranscriptRow["turn"]["status"] = "completed"
): TurnTranscriptRow =>
  ({
    rowId: `${turnId}:${messageRole}`,
    rowKind: "message",
    startedAt: "2026-04-18T00:00:00Z",
    turn: {
      turnId,
      sessionId: "session-1",
      status,
      startedAt: "2026-04-18T00:00:00Z",
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: []
    },
    turnIdentity: {
      label: turnId,
      kind: "turn"
    },
    messageRole,
    blocks: [],
    toolCalls: [],
    terminalStreams: [],
    approvals: [],
    hasProcessDetails: false,
    defaultProcessExpanded: false
  }) as TurnTranscriptRow;

describe("filterTranscriptRowsForChatTree", () => {
  it("falls back to the full transcript when no jumpable tree is available", () => {
    const rows = [row("turn-1"), row("turn-2")];

    expect(filterTranscriptRowsForChatTree(rows, undefined)).toEqual(rows);
    expect(
      filterTranscriptRowsForChatTree(rows, {
        sessionId: "session-1",
        engineId: "pi-acp",
        supportsJump: false,
        nodes: [],
        fetchedAt: "2026-04-18T00:00:00Z"
      })
    ).toEqual(rows);
  });

  it("shows only the current node ancestry turns after a chat-tree jump", () => {
    const rows = [row("turn-1"), row("turn-2"), row("turn-3")];

    const filtered = filterTranscriptRowsForChatTree(rows, {
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-2",
      nodes: [
        {
          nodeId: "node-1",
          label: "root",
          turnId: "turn-1",
          order: 1,
          isCurrent: false
        },
        {
          nodeId: "node-2",
          parentNodeId: "node-1",
          label: "branch",
          turnId: "turn-2",
          order: 2,
          isCurrent: true
        },
        {
          nodeId: "node-3",
          parentNodeId: "node-1",
          label: "sibling",
          turnId: "turn-3",
          order: 3,
          isCurrent: false
        }
      ],
      fetchedAt: "2026-04-18T00:00:00Z"
    });

    expect(filtered.map((item) => item.turn.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  it("does not show stale rows when the current chat-tree branch is not loaded", () => {
    const rows = [row("turn-old-1"), row("turn-old-2")];

    const filtered = filterTranscriptRowsForChatTree(rows, {
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-current",
      visibleTurnIds: ["turn-current"],
      nodes: [
        {
          nodeId: "node-current",
          label: "current",
          turnId: "turn-current",
          order: 1,
          isCurrent: true
        }
      ],
      fetchedAt: "2026-04-18T00:00:00Z"
    });

    expect(filtered).toEqual([]);
  });

  it("keeps a live canonical turn visible until the chat tree acknowledges it", () => {
    const liveRow = row("turn-live", "assistant", "streaming");

    expect(
      filterTranscriptRowsForChatTree([row("turn-stale"), liveRow], {
        sessionId: "session-1",
        engineId: "codex",
        supportsJump: true,
        currentNodeId: "node-current",
        visibleTurnIds: ["turn-current"],
        nodes: [],
        fetchedAt: "2026-04-18T00:00:00Z"
      })
    ).toEqual([liveRow]);
  });

  it("hides user rows from known sibling turns after a chat-tree jump", () => {
    const rows = [
      row("turn-user", "user"),
      row("turn-assistant"),
      row("turn-sibling-user", "user"),
      row("turn-sibling")
    ];

    const filtered = filterTranscriptRowsForChatTree(rows, {
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-assistant",
      nodes: [
        {
          nodeId: "node-assistant",
          label: "assistant",
          turnId: "turn-assistant",
          order: 1,
          isCurrent: true
        },
        {
          nodeId: "node-sibling",
          label: "sibling",
          turnId: "turn-sibling",
          order: 2,
          isCurrent: false
        }
      ],
      fetchedAt: "2026-04-18T00:00:00Z"
    });

    expect(filtered.map((item) => item.turn.turnId)).toEqual([
      "turn-assistant"
    ]);
  });

  it("hides a known running sibling while retaining an unacknowledged live turn", () => {
    const filtered = filterTranscriptRowsForChatTree(
      [
        row("turn-current"),
        row("turn-known-sibling", "user", "streaming"),
        row("turn-live-unacknowledged", "user", "streaming")
      ],
      {
        sessionId: "session-1",
        engineId: "codex",
        supportsJump: true,
        currentNodeId: "node-current",
        visibleTurnIds: ["turn-current"],
        nodes: [
          {
            nodeId: "node-current",
            label: "current",
            turnId: "turn-current",
            order: 1,
            isCurrent: true
          },
          {
            nodeId: "node-known-sibling",
            label: "known sibling",
            turnId: "turn-known-sibling",
            order: 2,
            isCurrent: false
          }
        ],
        fetchedAt: "2026-04-18T00:00:00Z"
      }
    );

    expect(filtered.map((item) => item.turn.turnId)).toEqual([
      "turn-current",
      "turn-live-unacknowledged"
    ]);
  });

  it("restricts composer turn selection to acknowledged branch members", () => {
    const rows = [
      row("turn-current"),
      row("turn-sibling-live", "assistant", "streaming"),
      row("turn-pending", "assistant", "streaming")
    ];
    const turns = rows.map((item) => item.turn);
    const chatTree = {
      sessionId: "session-1",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-current",
      visibleTurnIds: ["turn-current"],
      nodes: [
        {
          nodeId: "node-current",
          label: "current",
          turnId: "turn-current",
          order: 1,
          isCurrent: true
        },
        {
          nodeId: "node-sibling-live",
          label: "sibling",
          turnId: "turn-sibling-live",
          order: 2,
          isCurrent: false
        }
      ],
      fetchedAt: "2026-04-18T00:00:00Z"
    };

    expect(
      filterComposerTurnsForChatTree(turns, chatTree).map((turn) => turn.turnId)
    ).toEqual(["turn-current"]);
  });
});
