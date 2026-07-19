import { describe, expect, it } from "vitest";
import {
  resolveAutoRefreshBacklogAttempt,
  resolveAutoRefreshBacklogDecision,
  type AutoRefreshBacklogDecisionInput
} from "../src/ui/chat-shell/auto-refresh-backlog.js";

const baseInput = (): AutoRefreshBacklogDecisionInput => ({
  pressure: {
    pendingCount: 2_000,
    streamPendingCount: 700,
    lastCursor: "cursor-900",
    sessions: {
      "session-a": {
        streamPendingCount: 650,
        lastCursor: "cursor-800"
      }
    }
  },
  displayedSessionId: "session-a",
  visibilityState: "visible",
  nowMs: 60_000,
  cooldownMs: 30_000,
  streamThreshold: 500
});

describe("auto refresh backlog decision", () => {
  it("uses backlog pressure only to trigger a displayed-session refresh", () => {
    expect(resolveAutoRefreshBacklogDecision(baseInput())).toEqual({
      sessionId: "session-a"
    });
  });

  it("does not refresh while hidden or when another session owns the backlog", () => {
    expect(
      resolveAutoRefreshBacklogDecision({
        ...baseInput(),
        visibilityState: "hidden"
      })
    ).toBeUndefined();

    expect(
      resolveAutoRefreshBacklogDecision({
        ...baseInput(),
        displayedSessionId: "session-b"
      })
    ).toBeUndefined();
  });

  it("respects cooldown and in-flight refresh guards", () => {
    expect(
      resolveAutoRefreshBacklogDecision({
        ...baseInput(),
        lastRefreshStartedAtMs: 45_000
      })
    ).toBeUndefined();

    expect(
      resolveAutoRefreshBacklogDecision({
        ...baseInput(),
        refreshInFlight: true
      })
    ).toBeUndefined();
  });

  it("keeps hidden pressure pending and refreshes it when visible without another push", () => {
    const hiddenAttempt = resolveAutoRefreshBacklogAttempt({
      ...baseInput(),
      incomingPressure: baseInput().pressure,
      visibilityState: "hidden"
    });

    expect(hiddenAttempt.decision).toBeUndefined();
    expect(hiddenAttempt.pendingPressure?.sessions["session-a"]?.lastCursor).toBe(
      "cursor-800"
    );

    const visibleAttempt = resolveAutoRefreshBacklogAttempt({
      ...baseInput(),
      incomingPressure: undefined,
      pendingPressure: hiddenAttempt.pendingPressure,
      visibilityState: "visible",
      nowMs: 90_000
    });

    expect(visibleAttempt).toEqual({
      decision: {
        sessionId: "session-a"
      }
    });
  });
});
