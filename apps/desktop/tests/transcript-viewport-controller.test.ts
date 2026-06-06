import { describe, expect, it } from "vitest";
import {
  createTranscriptBottomTarget,
  isTranscriptNearBottom,
  isTranscriptScrollInputKey,
  resolveTranscriptScrollIntent,
  resolveTranscriptBottomRequest,
  shouldInterruptFollowTailForKeyboardScroll,
  shouldInterruptFollowTailForTouchScroll,
  shouldInterruptFollowTailForWheelScroll,
  shouldPreserveManualIntentDuringScroll,
  shouldUpdateViewportIntentFromScroll
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

  it("ignores programmatic scroll events unless they follow recent user scroll input", () => {
    expect(
      shouldUpdateViewportIntentFromScroll({
        isApplyingProgrammaticScroll: false,
        hasRecentUserScrollInput: false
      })
    ).toBe(true);
    expect(
      shouldUpdateViewportIntentFromScroll({
        isApplyingProgrammaticScroll: true,
        hasRecentUserScrollInput: false
      })
    ).toBe(false);
    expect(
      shouldUpdateViewportIntentFromScroll({
        isApplyingProgrammaticScroll: true,
        hasRecentUserScrollInput: true
      })
    ).toBe(true);
  });

  it("keeps a recent upward user scroll from being overwritten while it is still near bottom", () => {
    expect(
      shouldPreserveManualIntentDuringScroll({
        hasRecentFollowTailInterrupt: true,
        nextIntentType: "bottom"
      })
    ).toBe(true);
    expect(
      shouldPreserveManualIntentDuringScroll({
        hasRecentFollowTailInterrupt: true,
        nextIntentType: "manual"
      })
    ).toBe(false);
    expect(
      shouldPreserveManualIntentDuringScroll({
        hasRecentFollowTailInterrupt: false,
        nextIntentType: "bottom"
      })
    ).toBe(false);
  });

  it("recognizes keyboard input that can move the transcript viewport", () => {
    expect(isTranscriptScrollInputKey("ArrowUp")).toBe(true);
    expect(isTranscriptScrollInputKey("ArrowDown")).toBe(true);
    expect(isTranscriptScrollInputKey("PageUp")).toBe(true);
    expect(isTranscriptScrollInputKey("PageDown")).toBe(true);
    expect(isTranscriptScrollInputKey("Home")).toBe(true);
    expect(isTranscriptScrollInputKey("End")).toBe(true);
    expect(isTranscriptScrollInputKey(" ")).toBe(true);
    expect(isTranscriptScrollInputKey("Enter")).toBe(false);
    expect(isTranscriptScrollInputKey("Escape")).toBe(false);
  });

  it("interrupts follow-tail only for inputs that move toward earlier transcript content", () => {
    expect(shouldInterruptFollowTailForWheelScroll(-1)).toBe(true);
    expect(shouldInterruptFollowTailForWheelScroll(1)).toBe(false);
    expect(shouldInterruptFollowTailForTouchScroll(8)).toBe(true);
    expect(shouldInterruptFollowTailForTouchScroll(-8)).toBe(false);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: "ArrowUp"
      })
    ).toBe(true);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: "PageUp"
      })
    ).toBe(true);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: "Home"
      })
    ).toBe(true);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: " ",
        shiftKey: true
      })
    ).toBe(true);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: "ArrowDown"
      })
    ).toBe(false);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: "PageDown"
      })
    ).toBe(false);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: "End"
      })
    ).toBe(false);
    expect(
      shouldInterruptFollowTailForKeyboardScroll({
        key: " "
      })
    ).toBe(false);
  });
});
