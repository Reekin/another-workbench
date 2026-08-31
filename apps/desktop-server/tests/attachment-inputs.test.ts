import { describe, expect, it } from "vitest";
import type { Attachment } from "@another-workbench/shared";
import {
  buildAcpPromptContent,
  buildCodexTurnInput,
  buildLocalEchoMessageText
} from "../src/attachment-inputs.js";

describe("attachment input helpers", () => {
  it("renders attachment markdown into local echo content", () => {
    const attachments: Attachment[] = [
      {
        attachmentId: "image-1",
        mimeType: "image/png",
        uri: "file:///C:/Users/TestUser/Pictures/reference.png",
        name: "reference.png"
      },
      {
        attachmentId: "file-1",
        mimeType: "text/plain",
        uri: "file:///D:/workspace/another-workbench/README.md",
        name: "README.md"
      }
    ];

    expect(buildLocalEchoMessageText("Please inspect these.", attachments)).toBe(
      "Please inspect these.\n\n![reference.png](file:///C:/Users/TestUser/Pictures/reference.png)\n[README.md](file:///D:/workspace/another-workbench/README.md)"
    );
  });

  it("renders image display URIs into local echo content without leaking data URIs", () => {
    const attachments: Attachment[] = [
      {
        attachmentId: "image-1",
        mimeType: "image/png",
        uri: "data:image/png;base64,AAAA",
        displayUri:
          "file:///C:/Users/TestUser/AppData/Roaming/another-workbench/attachments/pasted-image.png",
        name: "clipboard.png"
      }
    ];

    const text = buildLocalEchoMessageText("Please inspect this.", attachments);

    expect(text).toBe(
      "Please inspect this.\n\n![clipboard.png](file:///C:/Users/TestUser/AppData/Roaming/another-workbench/attachments/pasted-image.png)"
    );
    expect(text).not.toContain("data:image/png;base64");
  });

  it("builds Codex turn input with images as structured items and files as text context", () => {
    const inputs = buildCodexTurnInput("Review the attached context.", [
      {
        attachmentId: "image-1",
        mimeType: "image/png",
        uri: "file:///C:/Users/TestUser/Pictures/reference.png",
        name: "reference.png"
      },
      {
        attachmentId: "image-2",
        mimeType: "image/png",
        uri: "data:image/png;base64,AAAA",
        displayUri: "file:///C:/Users/TestUser/AppData/Roaming/another-workbench/clipboard.png",
        name: "clipboard.png"
      },
      {
        attachmentId: "file-1",
        mimeType: "text/plain",
        uri: "file:///D:/workspace/another-workbench/README.md",
        name: "README.md"
      }
    ]);

    expect(inputs).toEqual([
      {
        type: "text",
        text:
          "Review the attached context.\n\nAttached file: README.md\nPath: D:\\workspace\\another-workbench\\README.md",
        text_elements: []
      },
      {
        type: "localImage",
        path: "C:\\Users\\TestUser\\Pictures\\reference.png"
      },
      {
        type: "image",
        url: "data:image/png;base64,AAAA"
      }
    ]);
  });

  it("builds ACP prompt content with pasted images as image blocks and files as resource links", () => {
    const prompt = buildAcpPromptContent("Use these inputs.", [
      {
        attachmentId: "image-1",
        mimeType: "image/png",
        uri: "data:image/png;base64,AAAA",
        displayUri: "file:///C:/Users/TestUser/AppData/Roaming/another-workbench/clipboard.png",
        name: "clipboard.png"
      },
      {
        attachmentId: "file-1",
        mimeType: "application/json",
        uri: "file:///D:/workspace/another-workbench/package.json",
        name: "package.json"
      }
    ]);

    expect(prompt).toEqual([
      {
        type: "text",
        text: "Use these inputs."
      },
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
        uri: "data:image/png;base64,AAAA"
      },
      {
        type: "resource_link",
        name: "package.json",
        title: "package.json",
        uri: "file:///D:/workspace/another-workbench/package.json",
        mimeType: "application/json"
      }
    ]);
  });
});
