import { describe, expect, it } from "vitest";
import { isTranscriptNearBottom } from "../src/ui/chat-shell/use-transcript-viewport-controller.js";

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
});
