import { describe, expect, it } from "vitest";
import type { ChatSession, Turn } from "@another-workbench/shared";
import { resolveInterruptTurnId } from "../src/ui/chat-shell/use-composer-controller.js";

const runningSession = (lastTurnId?: string): ChatSession => ({
  sessionId: "child-session",
  conversationId: "conversation-1",
  engineId: "codex",
  status: "running",
  lastTurnId,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:01.000Z"
});

const turn = (turnId: string, status: Turn["status"]): Turn => ({
  turnId,
  sessionId: "child-session",
  status,
  messageIds: [],
  toolCallIds: [],
  terminalIds: [],
  startedAt: "2026-08-08T00:00:00.000Z"
});

describe("resolveInterruptTurnId", () => {
  it("uses the unfiltered running turn for a child session", () => {
    expect(
      resolveInterruptTurnId({
        activeSession: runningSession("turn-running"),
        turns: [turn("turn-hidden-completed", "completed"), turn("turn-running", "streaming")]
      })
    ).toBe("turn-running");
  });

  it("falls back to the session last turn while the running window catches up", () => {
    expect(
      resolveInterruptTurnId({
        activeSession: runningSession("turn-running"),
        turns: []
      })
    ).toBe("turn-running");
  });

  it("does not expose Stop for an idle completed session", () => {
    expect(
      resolveInterruptTurnId({
        activeSession: {
          ...runningSession("turn-completed"),
          status: "idle"
        },
        turns: [turn("turn-completed", "completed")]
      })
    ).toBeUndefined();
  });
});
