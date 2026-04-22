import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdownView } from "../src/ui/chat-shell/MessageMarkdownView.js";

describe("MessageMarkdownView", () => {
  it("renders markdown content into semantic HTML", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-1:md",
          messageId: "message-1",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "# Heading\n\n- item",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<li>item</li>");
    expect(html).not.toContain("awb-participant-badge");
  });

  it("sanitizes unsafe html fragments in markdown source", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-2:md",
          messageId: "message-2",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "safe<script>alert('xss')</script>",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("safe");
    expect(html).not.toContain("<script>");
  });

  it("preserves local file images in markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-3:md",
          messageId: "message-3",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "![image](file:///C:/Users/TestUser/Pictures/cat.png)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="file:///C:/Users/TestUser/Pictures/cat.png"');
  });

  it("preserves local file links in markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        onActivateResourceLink={() => undefined}
        block={{
          blockId: "message-3b:md",
          messageId: "message-3b",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "[Spec](file:///C:/repo/docs/spec.md)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain('href="file:///C:/repo/docs/spec.md"');
    expect(html).toContain(">Spec</a>");
  });

  it("wraps inline images in a preview button when image opening is enabled", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        onPreviewImage={() => undefined}
        block={{
          blockId: "message-3c:md",
          messageId: "message-3c",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "![Diagram](file:///C:/repo/assets/diagram.png)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("<button");
    expect(html).toContain('class="awb-inline-image-button"');
    expect(html).toContain('src="file:///C:/repo/assets/diagram.png"');
  });

  it("preserves data-url images in markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-4:md",
          messageId: "message-4",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text: "![image](data:image/png;base64,AAAA)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });
});
