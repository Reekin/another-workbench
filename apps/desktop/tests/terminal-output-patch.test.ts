import { describe, expect, it } from "vitest";
import { computeTerminalOutputPatch } from "../src/ui/chat-shell/terminal-output-patch.js";

describe("computeTerminalOutputPatch", () => {
  it("writes full output on first paint without resetting", () => {
    expect(computeTerminalOutputPatch(0, "hello")).toEqual({
      shouldReset: false,
      writeText: "hello",
      nextAppliedLength: 5
    });
  });

  it("writes only the delta when output is appended", () => {
    expect(computeTerminalOutputPatch(5, "hello world")).toEqual({
      shouldReset: false,
      writeText: " world",
      nextAppliedLength: 11
    });
  });

  it("does not write anything when output is unchanged", () => {
    expect(computeTerminalOutputPatch(5, "hello")).toEqual({
      shouldReset: false,
      writeText: "",
      nextAppliedLength: 5
    });
  });

  it("resets when output shrinks (defensive against non-append updates)", () => {
    expect(computeTerminalOutputPatch(5, "hel")).toEqual({
      shouldReset: true,
      writeText: "hel",
      nextAppliedLength: 3
    });
  });
});

