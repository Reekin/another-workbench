import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("xterm", () => ({
  Terminal: class MockTerminal {
    public open(): void {}
    public write(): void {}
    public reset(): void {}
    public dispose(): void {}
  }
}));

import { TerminalStreamView } from "../src/ui/chat-shell/TerminalStreamView.js";

describe("TerminalStreamView", () => {
  it("keeps the xterm viewport out of the accessibility tree and exposes a plain-text mirror", () => {
    const markup = renderToStaticMarkup(
      <TerminalStreamView
        terminalStreams={[
          {
            terminalId: "terminal-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolCallId: "tool-1",
            status: "running",
            outputText: "$ pwd\nD:/workspace\n",
            startedAt: "2026-04-18T00:00:00Z"
          }
        ]}
      />
    );

    expect(markup).toContain('class="awb-terminal-output"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('aria-label="Terminal output text"');
    expect(markup).toContain("$ pwd");
    expect(markup).toContain("Plain Text Snapshot");
  });
});
