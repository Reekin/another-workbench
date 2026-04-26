import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessActivityView } from "../src/ui/chat-shell/ProcessActivityView.js";

describe("ProcessActivityView", () => {
  it("renders a linked tool and terminal stream as one expandable activity", () => {
    const markup = renderToStaticMarkup(
      <ProcessActivityView
        toolCalls={[
          {
            toolCallId: "tool-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "commandExecution",
            status: "completed",
            inputSummary: 'echo "bash is working" && pwd',
            outputSummary: "fallback output",
            startedAt: "2026-04-18T00:00:01.000Z",
            completedAt: "2026-04-18T00:00:02.000Z"
          }
        ]}
        terminalStreams={[
          {
            terminalId: "terminal-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolCallId: "tool-1",
            status: "completed",
            outputText: '$ echo "bash is working" && pwd\nbash is working\n/I/gpt-projects/chat\n',
            exitCode: 0,
            startedAt: "2026-04-18T00:00:01.000Z",
            completedAt: "2026-04-18T00:00:02.000Z"
          }
        ]}
      />
    );

    expect((markup.match(/awb-process-activity"/g) ?? []).length).toBe(1);
    expect(markup).toContain('Shell echo &quot;bash is working&quot; &amp;&amp; pwd');
    expect(markup).toContain("completed (exit 0)");
    expect(markup).toContain('echo &quot;bash is working&quot; &amp;&amp; pwd');
    expect(markup).toContain("bash is working");
    expect(markup).toContain("/I/gpt-projects/chat");
    expect(markup).not.toContain("fallback output");
  });
});
