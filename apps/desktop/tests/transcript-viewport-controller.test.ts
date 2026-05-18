import { describe, expect, it } from "vitest";
import {
  createTranscriptBottomTarget,
  isTranscriptNearBottom,
  resolveTranscriptScrollIntent,
  resolveTranscriptBottomRequest
} from "../src/ui/chat-shell/use-transcript-viewport-controller.js";

describe("transcript viewport controller", () => {
  it("treats the transcript as sticky while it is close to the bottom", () => {
    expect(
      isTranscriptNearBottom({
        scrollHeight: 1_000,
        scrollTop: 654,
        clientHeight: 250
      })
    ).toBe(true);
  });

  it("does not force sticky scrolling after the user scrolls away from the bottom", () => {
    expect(
      isTranscriptNearBottom({
        scrollHeight: 1_000,
        scrollTop: 600,
        clientHeight: 250
      })
    ).toBe(false);
  });

  it("keeps an explicit bottom intent while the user remains near the bottom", () => {
    expect(
      resolveTranscriptScrollIntent({
        displayedSessionId: "session-1",
        isNearBottom: true
      })
    ).toEqual({
      sessionId: "session-1",
      type: "bottom"
    });
    expect(
      resolveTranscriptScrollIntent({
        displayedSessionId: "session-1",
        isNearBottom: false
      })
    ).toEqual({
      sessionId: "session-1",
      type: "manual"
    });
  });

  it("creates an explicit bottom target for user-initiated transcript jumps", () => {
    expect(createTranscriptBottomTarget("session-1")).toEqual({
      sessionId: "session-1",
      type: "bottom"
    });
    expect(createTranscriptBottomTarget(undefined)).toBeUndefined();
  });

  it("resolves bottom requests without letting stale inactive sessions block sticky scrolling", () => {
    expect(
      resolveTranscriptBottomRequest({
        sessionId: "session-1",
        displayedSessionId: "session-1"
      })
    ).toEqual({
      immediate: {
        sessionId: "session-1",
        type: "bottom"
      }
    });
    expect(
      resolveTranscriptBottomRequest({
        sessionId: "session-old",
        displayedSessionId: "session-current"
      })
    ).toEqual({});
    expect(
      resolveTranscriptBottomRequest({
        sessionId: "session-next",
        displayedSessionId: "session-current",
        allowPendingForInactive: true
      })
    ).toEqual({
      pending: {
        sessionId: "session-next",
        type: "bottom"
      }
    });
  });
});
