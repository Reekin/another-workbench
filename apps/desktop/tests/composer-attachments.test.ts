import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComposerAttachment,
  createComposerAttachments,
  extractPastedMessageImages,
  formatComposerAttachmentSize,
  mergeComposerAttachments,
  releaseComposerAttachments,
  writeComposerAttachmentDraft,
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
      value: "D:\\workspace\\another-workbench\\README.md"
    });

    const attachment = await createComposerAttachment(file, "picker");

    expect(attachment.attachment.uri).toBe(
      "file:///D:/workspace/another-workbench/README.md"
    );
    expect(attachment.previewUrl).toBeUndefined();
    expect(attachment.releasePreviewUrl).toBe(false);
    expect(attachment.sizeLabel).toBe("5 B");
  });

  it("uses the native file path as the preview source for picker images", async () => {
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "diagram.png", {
      type: "image/png",
      lastModified: 1234567890
    });
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "D:\\workspace\\another-workbench\\diagram.png"
    });

    const attachment = await createComposerAttachment(file, "picker");

    expect(attachment.attachment.uri).toContain(
      "file:///D:/workspace/another-workbench/diagram.png?"
    );
    expect(attachment.attachment.uri).toContain("awb_file_mtime=1234567890");
    expect(attachment.attachment.uri).toContain("awb_file_size=4");
    expect(attachment.previewUrl).toContain(
      "file:///D:/workspace/another-workbench/diagram.png?"
    );
    expect(attachment.previewUrl).toContain("awb_image_cache=");
    expect(attachment.previewUrl).not.toContain("blob:");
    expect(attachment.releasePreviewUrl).toBe(false);
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

  it("uses a materialized display URI for pasted image previews", async () => {
    const materializeDataUri = vi.fn(async () => ({
      displayUri:
        "file:///C:/Users/TestUser/AppData/Roaming/another-workbench/attachments/pasted-image.png"
    }));
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "", {
      type: "image/png"
    });

    const attachment = await createComposerAttachment(file, "paste", {
      materializeDataUri
    });

    expect(attachment.attachment.uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(attachment.attachment.displayUri).toBe(
      "file:///C:/Users/TestUser/AppData/Roaming/another-workbench/attachments/pasted-image.png"
    );
    expect(attachment.previewUrl).toContain(
      "file:///C:/Users/TestUser/AppData/Roaming/another-workbench/attachments/pasted-image.png?"
    );
    expect(attachment.previewUrl).toContain("awb_image_cache=");
    expect(materializeDataUri).toHaveBeenCalledWith({
      attachmentId: attachment.attachment.attachmentId,
      dataUri: attachment.attachment.uri,
      mimeType: "image/png",
      name: "pasted-image.png"
    });
  });

  it("keeps multiple pasted images as separate composer attachments", async () => {
    const attachments = await createComposerAttachments(
      [
        new File([Uint8Array.from([137, 80, 78, 71])], "", {
          type: "image/png"
        }),
        new File([Uint8Array.from([255, 216, 255])], "", {
          type: "image/jpeg"
        })
      ],
      "paste"
    );

    expect(attachments).toHaveLength(2);
    expect(attachments.map((attachment) => attachment.displayName)).toEqual([
      "pasted-image.png",
      "pasted-image.jpg"
    ]);
    expect(attachments.every((attachment) => attachment.isImage)).toBe(true);
    expect(attachments.every((attachment) => attachment.previewUrl)).toBe(true);
  });

  it("extracts copied message images from base64 markdown", async () => {
    const extracted = extractPastedMessageImages(
      "Inspect these.\n\n![clipboard.png](data:image/png;base64,AQID)\n" +
        "![image](data:image/jpeg;base64,/9j/)"
    );

    expect(extracted?.text).toBe("Inspect these.");
    expect(extracted?.files.map((file) => [file.name, file.type])).toEqual([
      ["clipboard.png", "image/png"],
      ["pasted-image.jpg", "image/jpeg"]
    ]);
    expect(
      Array.from(new Uint8Array(await extracted!.files[0]!.arrayBuffer()))
    ).toEqual([1, 2, 3]);
  });

  it("replaces merged attachments by dedupe key", () => {
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

    expect(result.attachments).toEqual([duplicate, next]);
    expect(result.replaced).toEqual([existing]);
    expect(result.skipped).toEqual([]);
  });

  it("keeps attachment drafts isolated by session", () => {
    const imageA = {} as ComposerAttachment;
    const imageB = {} as ComposerAttachment;
    const withSessionA = writeComposerAttachmentDraft({}, "session-a", [imageA]);
    const withBoth = writeComposerAttachmentDraft(withSessionA, "session-b", [imageB]);

    expect(withBoth).toEqual({
      "session-a": [imageA],
      "session-b": [imageB]
    });

    const withoutSessionB = writeComposerAttachmentDraft(withBoth, "session-b", []);
    expect(withoutSessionB).toEqual({ "session-a": [imageA] });
    expect(withoutSessionB).not.toHaveProperty("session-b");
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
