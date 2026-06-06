import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProcessActivityItemView,
  ProcessActivityView,
  type ProcessActivityEntry
} from "../src/ui/chat-shell/ProcessActivityView.js";

const findElementByClassName = (
  node: unknown,
  className: string
): { props: Record<string, unknown> } | undefined => {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props?.className === className) {
    return { props };
  }
  const children = props?.children;
  const childNodes = Array.isArray(children) ? children : [children];
  for (const child of childNodes) {
    const match = findElementByClassName(child, className);
    if (match) {
      return match;
    }
  }
  return undefined;
};

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

  it("renders image activity output as an image preview", () => {
    const markup = renderToStaticMarkup(
      <ProcessActivityView
        toolCalls={[
          {
            toolCallId: "image-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "imageGeneration",
            status: "completed",
            inputSummary: "A quiet dashboard screenshot",
            outputSummary:
              "![Generated image](file:///D:/workspace/generated.png)\nprompt: A quiet dashboard screenshot",
            startedAt: "2026-04-18T00:00:01.000Z",
            completedAt: "2026-04-18T00:00:02.000Z"
          }
        ]}
        terminalStreams={[]}
        onPreviewImage={() => undefined}
      />
    );

    expect(markup).toContain("Image generation A quiet dashboard screenshot");
    expect(markup).toContain("awb-inline-image-button");
    expect(markup).toContain(
      'src="file:///D:/workspace/generated.png?awb_image_cache=tool%3Aimage-1"'
    );
    expect(markup).toContain("prompt: A quiet dashboard screenshot");
    expect(markup).not.toContain("![Generated image]");
  });

  it("passes the cache-busted image URL to the preview callback", () => {
    const onPreviewImage = vi.fn();
    const entry: ProcessActivityEntry = {
      id: "tool:image-1",
      label: "View image",
      summary: "View image",
      status: "completed",
      inputText: "I:/images/current.png",
      outputText:
        "![Viewed image](file:///I:/images/current.png?awb_file_mtime=111&awb_file_size=4)\npath: I:/images/current.png",
      terminalStreams: []
    };

    const element = ProcessActivityItemView({ entry, onPreviewImage });
    const button = findElementByClassName(element, "awb-inline-image-button");
    expect(button).toBeDefined();
    (button?.props.onClick as () => void)();

    expect(onPreviewImage).toHaveBeenCalledWith({
      src: "file:///I:/images/current.png?awb_file_mtime=111&awb_file_size=4&awb_image_cache=tool%3Aimage-1",
      alt: "Viewed image"
    });
  });

  it("keeps right parentheses inside process image URLs", () => {
    const markup = renderToStaticMarkup(
      <ProcessActivityView
        toolCalls={[
          {
            toolCallId: "image-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "imageView",
            status: "completed",
            inputSummary: "I:/images/image (1).png",
            outputSummary:
              "![Viewed image](file:///I:/images/image%20(1).png)\npath: I:/images/image (1).png",
            startedAt: "2026-04-18T00:00:01.000Z",
            completedAt: "2026-04-18T00:00:02.000Z"
          }
        ]}
        terminalStreams={[]}
        onPreviewImage={() => undefined}
      />
    );

    expect(markup).toContain(
      'src="file:///I:/images/image%20(1).png?awb_image_cache=tool%3Aimage-1"'
    );
    expect(markup).toContain("I:/images/image (1).png");
    expect(markup).not.toContain("path: I:/images/image (1).png");
  });
});
