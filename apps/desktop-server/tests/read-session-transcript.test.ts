import { describe, expect, it } from "vitest";
import type { DomainSnapshot, MessageBlock, Turn } from "@another-workbench/shared";
import { buildReadSessionTranscript } from "../src/read-session-transcript.js";

const baseSession = {
  sessionId: "session-1",
  conversationId: "conversation-1",
  engineId: "codex",
  status: "idle" as const,
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:05:00.000Z"
};

const baseSnapshot = (
  turns: Turn[],
  messageBlocks: MessageBlock[]
): DomainSnapshot => ({
  conversations: [
    {
      conversationId: "conversation-1",
      participantEngineIds: ["codex"],
      activeSessionId: "session-1",
      sessionIds: ["session-1"],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:05:00.000Z"
    }
  ],
  sessions: [baseSession],
  turns,
  messageBlocks,
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  runtimeInteractions: [],
  participants: [],
  sessionRelations: []
});

const turn = (input: Partial<Turn> & Pick<Turn, "turnId">): Turn => ({
  sessionId: "session-1",
  status: "completed",
  finishReason: "completed",
  startedAt: "2026-06-06T00:01:00.000Z",
  completedAt: "2026-06-06T00:01:10.000Z",
  messageIds: [],
  toolCallIds: [],
  terminalIds: [],
  approvalRequestIds: [],
  interactionRequestIds: [],
  ...input
});

const block = (
  input: Partial<MessageBlock> &
    Pick<MessageBlock, "blockId" | "messageId" | "turnId" | "role" | "text">
): MessageBlock => ({
  sessionId: "session-1",
  kind: "markdown",
  startedAt: "2026-06-06T00:01:01.000Z",
  ...input
});

describe("buildReadSessionTranscript", () => {
  it("prefers finalMessageId over earlier assistant commentary", () => {
    const snapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          finalMessageId: "assistant-final",
          messageIds: ["user-1", "assistant-commentary", "assistant-final"]
        })
      ],
      [
        block({
          blockId: "user-1-block",
          messageId: "user-1",
          turnId: "turn-1",
          role: "user",
          text: "What happened?"
        }),
        block({
          blockId: "assistant-commentary-block",
          messageId: "assistant-commentary",
          turnId: "turn-1",
          role: "assistant",
          phase: "commentary",
          text: "I am checking files."
        }),
        block({
          blockId: "assistant-final-block",
          messageId: "assistant-final",
          turnId: "turn-1",
          role: "assistant",
          phase: "final_answer",
          text: "The fix is complete."
        })
      ]
    );

    const result = buildReadSessionTranscript({ snapshot, sessionId: "session-1" });

    expect(result.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        user: ["What happened?"],
        agentFinal: "The fix is complete."
      })
    ]);
    expect(JSON.stringify(result)).not.toContain("checking files");
  });

  it("uses final_answer phase when finalMessageId is unavailable", () => {
    const snapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          messageIds: ["assistant-commentary", "assistant-final"]
        })
      ],
      [
        block({
          blockId: "assistant-commentary-block",
          messageId: "assistant-commentary",
          turnId: "turn-1",
          role: "assistant",
          phase: "commentary",
          text: "Interim work."
        }),
        block({
          blockId: "assistant-final-block",
          messageId: "assistant-final",
          turnId: "turn-1",
          role: "assistant",
          phase: "final_answer",
          text: "Final answer."
        })
      ]
    );

    expect(
      buildReadSessionTranscript({ snapshot, sessionId: "session-1" }).turns[0]
        ?.agentFinal
    ).toBe("Final answer.");
  });

  it("uses legacy unphased assistant text only when no phase-aware assistant blocks exist", () => {
    const legacySnapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          messageIds: ["assistant-legacy"]
        })
      ],
      [
        block({
          blockId: "assistant-legacy-block",
          messageId: "assistant-legacy",
          turnId: "turn-1",
          role: "assistant",
          text: "Legacy answer."
        })
      ]
    );
    const phaseAwareSnapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          messageIds: ["assistant-legacy", "assistant-commentary"]
        })
      ],
      [
        block({
          blockId: "assistant-legacy-block",
          messageId: "assistant-legacy",
          turnId: "turn-1",
          role: "assistant",
          text: "Should stay hidden."
        }),
        block({
          blockId: "assistant-commentary-block",
          messageId: "assistant-commentary",
          turnId: "turn-1",
          role: "assistant",
          phase: "commentary",
          text: "Phase-aware commentary."
        })
      ]
    );

    expect(
      buildReadSessionTranscript({
        snapshot: legacySnapshot,
        sessionId: "session-1"
      }).turns[0]?.agentFinal
    ).toBe("Legacy answer.");
    expect(
      buildReadSessionTranscript({
        snapshot: phaseAwareSnapshot,
        sessionId: "session-1"
      }).turns[0]?.agentFinal
    ).toBeUndefined();
  });

  it("sorts turns chronologically and reports truncation for latest-turn limits", () => {
    const snapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-2",
          startedAt: "2026-06-06T00:02:00.000Z"
        }),
        turn({
          turnId: "turn-1",
          startedAt: "2026-06-06T00:01:00.000Z"
        }),
        turn({
          turnId: "turn-3",
          startedAt: "2026-06-06T00:03:00.000Z"
        })
      ],
      []
    );

    const result = buildReadSessionTranscript({
      snapshot,
      sessionId: "session-1",
      limit: 2
    });

    expect(result.turns.map((entry) => entry.turnId)).toEqual(["turn-2", "turn-3"]);
    expect(result.turnCount).toBe(2);
    expect(result.totalTurnCount).toBe(3);
    expect(result.returnedTurnCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedByTurns).toBe(true);
    expect(result.truncatedByChars).toBe(false);
  });

  it("uses a bounded default turn limit", () => {
    const snapshot = baseSnapshot(
      Array.from({ length: 51 }, (_value, index) =>
        turn({
          turnId: `turn-${index + 1}`,
          startedAt: `2026-06-06T00:${String(index).padStart(2, "0")}:00.000Z`
        })
      ),
      []
    );

    const result = buildReadSessionTranscript({
      snapshot,
      sessionId: "session-1"
    });

    expect(result.totalTurnCount).toBe(51);
    expect(result.returnedTurnCount).toBe(50);
    expect(result.turns[0]?.turnId).toBe("turn-2");
    expect(result.truncatedByTurns).toBe(true);
  });

  it("collects blocks by turn messageIds when block turnId is stale", () => {
    const snapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          finalMessageId: "assistant-final",
          messageIds: ["user-1", "assistant-final"]
        })
      ],
      [
        block({
          blockId: "user-1-block",
          messageId: "user-1",
          turnId: "stale-turn",
          role: "user",
          text: "Recovered user text"
        }),
        block({
          blockId: "assistant-final-block",
          messageId: "assistant-final",
          turnId: "stale-turn",
          role: "assistant",
          phase: "final_answer",
          text: "Recovered final text"
        })
      ]
    );

    expect(
      buildReadSessionTranscript({ snapshot, sessionId: "session-1" }).turns[0]
    ).toEqual(
      expect.objectContaining({
        user: ["Recovered user text"],
        agentFinal: "Recovered final text"
      })
    );
  });

  it("preserves user text order and filters non-text or process-like blocks", () => {
    const snapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          finalMessageId: "assistant-final",
          messageIds: ["user-1", "user-2", "tool-ref", "assistant-final"]
        })
      ],
      [
        block({
          blockId: "user-2-block",
          messageId: "user-2",
          turnId: "turn-1",
          role: "user",
          kind: "plain_text",
          text: "Second user line",
          startedAt: "2026-06-06T00:01:03.000Z"
        }),
        block({
          blockId: "tool-ref-block",
          messageId: "tool-ref",
          turnId: "turn-1",
          role: "assistant",
          kind: "tool_ref",
          text: "Tool detail that should not leak",
          startedAt: "2026-06-06T00:01:04.000Z"
        }),
        block({
          blockId: "user-1-block",
          messageId: "user-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "First user line",
          startedAt: "2026-06-06T00:01:01.000Z"
        }),
        block({
          blockId: "assistant-final-block",
          messageId: "assistant-final",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          phase: "final_answer",
          text: "Visible final text",
          startedAt: "2026-06-06T00:01:05.000Z"
        })
      ]
    );

    const resultText = JSON.stringify(
      buildReadSessionTranscript({
        snapshot,
        sessionId: "session-1"
      })
    );
    const result = JSON.parse(resultText) as {
      turns: Array<{ user: string[]; agentFinal?: string }>;
    };

    expect(result.turns[0]?.user).toEqual(["First user line", "Second user line"]);
    expect(result.turns[0]?.agentFinal).toBe("Visible final text");
    expect(resultText).not.toContain("Tool detail that should not leak");
  });

  it("applies a text character budget with explicit truncation metadata", () => {
    const snapshot = baseSnapshot(
      [
        turn({
          turnId: "turn-1",
          finalMessageId: "assistant-final",
          messageIds: ["user-1", "assistant-final"]
        })
      ],
      [
        block({
          blockId: "user-1-block",
          messageId: "user-1",
          turnId: "turn-1",
          role: "user",
          text: "12345"
        }),
        block({
          blockId: "assistant-final-block",
          messageId: "assistant-final",
          turnId: "turn-1",
          role: "assistant",
          phase: "final_answer",
          text: "67890"
        })
      ]
    );

    const result = buildReadSessionTranscript({
      snapshot,
      sessionId: "session-1",
      maxTextChars: 7
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedByChars).toBe(true);
    expect(result.turns[0]?.user).toEqual(["12345"]);
    expect(result.turns[0]?.agentFinal).toBe("67");
  });

  it("fails clearly for unknown AWB sessions", () => {
    expect(() =>
      buildReadSessionTranscript({
        snapshot: baseSnapshot([], []),
        sessionId: "missing-session"
      })
    ).toThrow("Unknown session: missing-session");
  });
});
