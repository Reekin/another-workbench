import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MessageMarkdownView,
  splitStreamingMarkdown,
  splitUserMessageText
} from "../src/ui/chat-shell/MessageMarkdownView.js";

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
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<li>item</li>");
    expect(html).not.toContain("awb-participant-badge");
  });

  it("splits streaming markdown at a stable block boundary", () => {
    expect(splitStreamingMarkdown("Stable paragraph\n\ncurrent tail")).toEqual({
      stableMarkdown: "Stable paragraph\n\n",
      tailText: "current tail"
    });
    expect(splitStreamingMarkdown("Stable paragraph\n\n```bash\necho hello")).toEqual({
      stableMarkdown: "Stable paragraph\n\n",
      tailText: "```bash\necho hello"
    });
    expect(splitStreamingMarkdown("Stable paragraph\n\n```bash\necho hello\n```\n")).toEqual({
      stableMarkdown: "Stable paragraph\n\n```bash\necho hello\n```\n",
      tailText: ""
    });
  });

  it("renders streaming tail as plain text instead of reparsing unstable markdown", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-streaming:md",
          messageId: "message-streaming",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "Stable paragraph\n\n```bash\necho hello\n- still plain",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z"
        }}
      />
    );

    expect(html).toContain("<p>Stable paragraph</p>");
    expect(html).toContain('class="awb-message__streaming-tail"');
    expect(html).toContain("```bash");
    expect(html).toContain("echo hello");
    expect(html).toContain("- still plain");
    expect(html).not.toContain("language-bash");
    expect(html).not.toContain("<li>still plain</li>");
  });

  it("preserves user line breaks, Windows paths, and markdown punctuation verbatim", () => {
    const text =
      "1.Trim only checks the edges\n2.Keep this line separate\nI:\\GameDev\\Projects\\ConfigDatas\\.Json\\PlayPod\\1.json\n# literal heading\n**literal emphasis**";
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-user-plain:md",
          messageId: "message-user-plain",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "user",
          kind: "markdown",
          text,
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('class="awb-message__user-text"');
    expect(html).toContain("1.Trim only checks the edges\n2.Keep this line separate");
    expect(html).toContain("I:\\GameDev\\Projects\\ConfigDatas\\.Json\\PlayPod\\1.json");
    expect(html).toContain("# literal heading\n**literal emphasis**");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<strong>");
  });

  it("splits local echo attachments from exact user text", () => {
    expect(
      splitUserMessageText(
        "line one\nline two\n\n![image](file:///C:/image.png)\n[Spec](file:///C:/spec.md)"
      )
    ).toEqual({
      text: "line one\nline two",
      attachmentMarkdown: "![image](file:///C:/image.png)\n[Spec](file:///C:/spec.md)"
    });
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
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
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
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain(
      'src="file:///C:/Users/TestUser/Pictures/cat.png?awb_image_cache=message-3%3Amd%3Aattachments"'
    );
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
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('href="file:///C:/repo/docs/spec.md"');
    expect(html).toContain(">Spec</a>");
  });

  it("shows unsupported link targets without making them navigable", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-3e:md",
          messageId: "message-3e",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "[README.md](I:/repo/README.md:3)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('class="awb-message__unsupported-link"');
    expect(html).toContain(">README.md<");
    expect(html).toContain(
      '<code class="awb-message__unsupported-link-target">I:/repo/README.md:3</code>'
    );
    expect(html).not.toContain("href=");
  });

  it("renders web links as external browser targets", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-3d:md",
          messageId: "message-3d",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "[OpenAI](https://openai.com/)",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('href="https://openai.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
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
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<button");
    expect(html).toContain('class="awb-inline-image-button"');
    expect(html).toContain(
      'src="file:///C:/repo/assets/diagram.png?awb_image_cache=message-3c%3Amd%3Aattachments"'
    );
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
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("renders closed mermaid fences as diagram containers with code fallback", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-4b:md",
          messageId: "message-4b",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "Before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("Before");
    expect(html).toContain("awb-message--contains-mermaid");
    expect(html).toContain('class="awb-mermaid"');
    expect(html).toContain("graph TD");
    expect(html).toContain("A --&gt; B");
    expect(html).toContain("After");
    expect(html).not.toContain("language-mermaid");
  });

  it("keeps incomplete mermaid fences as normal markdown code", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-4c:md",
          messageId: "message-4c",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: "```mermaid\ngraph TD\n  A --> B",
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("language-mermaid");
    expect(html).toContain("graph TD");
    expect(html).not.toContain('class="awb-mermaid"');
  });

  it("renders code review findings as a readable card instead of raw directive text", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-5:md",
          messageId: "message-5",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: '::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="I:/repo/src/foo.ts" start=10 end=11 priority=2}',
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain('class="awb-code-comment"');
    expect(html).toContain("Finding");
    expect(html).toContain("[P2] Off-by-one");
    expect(html).toContain("Loop iterates past the end when length is 0.");
    expect(html).toContain("I:/repo/src/foo.ts:10-11");
    expect(html).toContain("P2");
    expect(html).not.toContain("::code-comment{");
  });

  it("renders finding inline code and keeps Windows paths separate from locations", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdownView
        block={{
          blockId: "message-6:md",
          messageId: "message-6",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          kind: "markdown",
          text: '::code-comment{title="[P2] \`finalMessageId\` drift" body="When \`turn.completed\` lands before \`message.completed\`, the fallback can stick." file="I:\\\\gpt-projects\\\\agent-wrappers\\\\another-workbench\\\\packages\\\\core\\\\src\\\\domain-projector.ts" start=326 end=434 priority=2 confidence=0.84}',
          actor: {
            participantId: "participant-1",
            engineId: "agent-codex"
          },
          startedAt: "2026-04-17T00:00:00.000Z",
          completedAt: "2026-04-17T00:00:01.000Z"
        }}
      />
    );

    expect(html).toContain("<code>finalMessageId</code>");
    expect(html).toContain("<code>turn.completed</code>");
    expect(html).toContain("<code>message.completed</code>");
    expect(html).toContain("I:\\gpt-projects\\agent-wrappers\\another-workbench\\packages\\core\\src\\domain-projector.ts:326-434");
    expect(html).not.toContain("start=326");
  });
});
