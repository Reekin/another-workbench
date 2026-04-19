import { describe, expect, it } from "vitest";
import { normalizeTerminalOutput } from "../src/ui/chat-shell/terminal-output.js";

describe("normalizeTerminalOutput", () => {
  it("keeps carriage-return rewrite semantics for streamed terminal lines", () => {
    const output = "abc\rZ\n123\r45";
    expect(normalizeTerminalOutput(output)).toBe("Zbc\n453");
  });

  it("returns empty text for empty stream", () => {
    expect(normalizeTerminalOutput("")).toBe("");
  });
});
