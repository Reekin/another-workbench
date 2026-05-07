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

  it("renders context compaction as running then finished copy", () => {
    const runningMarkup = renderToStaticMarkup(
      <ProcessActivityView
        toolCalls={[
          {
            toolCallId: "compact-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "contextCompaction",
            status: "running",
            inputSummary: "compacting...",
            startedAt: "2026-04-18T00:00:01.000Z"
          }
        ]}
        terminalStreams={[]}
      />
    );
    const completedMarkup = renderToStaticMarkup(
      <ProcessActivityView
        toolCalls={[
          {
            toolCallId: "compact-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "contextCompaction",
            status: "completed",
            inputSummary: "compacting...",
            outputSummary: "compaction finished",
            startedAt: "2026-04-18T00:00:01.000Z",
            completedAt: "2026-04-18T00:00:02.000Z"
          }
        ]}
        terminalStreams={[]}
      />
    );

    expect(runningMarkup).toContain("compacting...");
    expect(runningMarkup).toContain("running");
    expect(completedMarkup).toContain("compaction finished");
    expect(completedMarkup).toContain("completed");
  });

  it("does not repeat identical process input and output when expanded", () => {
    const markup = renderToStaticMarkup(
      <ProcessActivityView
        toolCalls={[
          {
            toolCallId: "search-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "webSearch",
            status: "completed",
            inputSummary: "Search\nquery: mini PC low power CPUs",
            outputSummary: "Search\nquery: mini PC low power CPUs",
            startedAt: "2026-04-18T00:00:01.000Z",
            completedAt: "2026-04-18T00:00:02.000Z"
          },
          {
            toolCallId: "reason-empty",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "reasoning",
            status: "completed",
            inputSummary: "Reasoning",
            startedAt: "2026-04-18T00:00:03.000Z",
            completedAt: "2026-04-18T00:00:04.000Z"
          }
        ]}
        terminalStreams={[]}
      />
    );

    expect(markup).toContain("Web search Search");
    expect(markup).toContain("query: mini PC low power CPUs");
    expect(markup).not.toContain("(no output yet)");
    expect((markup.match(/query: mini PC low power CPUs/g) ?? []).length).toBe(1);
  });
});
