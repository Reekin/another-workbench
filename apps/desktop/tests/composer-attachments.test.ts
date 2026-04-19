import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComposerAttachment,
  formatComposerAttachmentSize,
  mergeComposerAttachments,
  releaseComposerAttachments,
  type ComposerAttachment
} from "../src/ui/chat-shell/composer-attachments.js";

describe("composer attachment helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds file URIs for picker attachments when Electron exposes a native path", async () => {
    const file = new File(["hello"], "README.md", {
      type: "text/plain"
    });
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "I:\\gpt-projects\\agent-wrappers\\another-workbench\\README.md"
    });

    const attachment = await createComposerAttachment(file, "picker");

    expect(attachment.attachment.uri).toBe(
      "file:///D:/workspace/another-workbench/README.md"
    );
    expect(attachment.previewUrl).toBeUndefined();
    expect(attachment.releasePreviewUrl).toBe(false);
    expect(attachment.sizeLabel).toBe("5 B");
  });

  it("builds data URIs and fallback names for pasted images", async () => {
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "", {
      type: "image/png"
    });

    const attachment = await createComposerAttachment(file, "paste");

    expect(attachment.displayName).toBe("pasted-image.png");
    expect(attachment.attachment.name).toBe("pasted-image.png");
    expect(attachment.attachment.uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(attachment.previewUrl).toBe(attachment.attachment.uri);
    expect(attachment.releasePreviewUrl).toBe(false);
  });

  it("deduplicates merged attachments by dedupe key", () => {
    const existing: ComposerAttachment = {
      attachment: {
        attachmentId: "existing",
        mimeType: "text/plain",
        name: "README.md",
        uri: "file:///D:/workspace/another-workbench/README.md"
      },
      dedupeKey: "readme",
      displayName: "README.md",
      isImage: false,
      mimeType: "text/plain",
      releasePreviewUrl: false,
      size: 5,
      sizeLabel: "5 B"
    };
    const duplicate: ComposerAttachment = {
      ...existing,
      attachment: {
        ...existing.attachment,
        attachmentId: "duplicate"
      }
    };
    const next: ComposerAttachment = {
      ...existing,
      attachment: {
        attachmentId: "next",
        mimeType: "application/json",
        name: "package.json",
        uri: "file:///D:/workspace/another-workbench/package.json"
      },
      dedupeKey: "package",
      displayName: "package.json",
      mimeType: "application/json"
    };

    const result = mergeComposerAttachments([existing], [duplicate, next]);

    expect(result.attachments).toEqual([existing, next]);
    expect(result.skipped).toEqual([duplicate]);
  });

  it("releases only preview URLs that require cleanup", () => {
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");

    releaseComposerAttachments([
      {
        attachment: {
          attachmentId: "image-1",
          mimeType: "image/png",
          name: "preview.png",
          uri: "file:///C:/Users/TestUser/Pictures/preview.png"
        },
        dedupeKey: "image-1",
        displayName: "preview.png",
        isImage: true,
        mimeType: "image/png",
        previewUrl: "blob:preview",
        releasePreviewUrl: true,
        size: 100,
        sizeLabel: "100 B"
      },
      {
        attachment: {
          attachmentId: "image-2",
          mimeType: "image/png",
          name: "clipboard.png",
          uri: "data:image/png;base64,AAAA"
        },
        dedupeKey: "image-2",
        displayName: "clipboard.png",
        isImage: true,
        mimeType: "image/png",
        previewUrl: "data:image/png;base64,AAAA",
        releasePreviewUrl: false,
        size: 4,
        sizeLabel: "4 B"
      }
    ]);

    expect(revokeObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview");
  });

  it("formats attachment sizes for the composer UI", () => {
    expect(formatComposerAttachmentSize(512)).toBe("512 B");
    expect(formatComposerAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatComposerAttachmentSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
