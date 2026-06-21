import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { materializeAttachmentDataUri } from "../src/electron/attachment-materializer.js";

describe("attachment materializer", () => {
  it("writes pasted image data URIs to a local display file", async () => {
    const root = await mkdtemp(join(tmpdir(), "awb-attachment-materializer-"));
    try {
      const result = await materializeAttachmentDataUri(
        {
          attachmentId: "image-1",
          dataUri: "data:image/png;base64,iVBORw0KGgo=",
          mimeType: "image/png",
          name: "clipboard image.png"
        },
        root
      );

      expect(result.bytesWritten).toBe(8);
      expect(result.displayUri).toContain("clipboard-image-");
      expect(result.displayUri).toMatch(/\.png$/u);
      expect(await readFile(result.filePath, "base64")).toBe("iVBORw0KGgo=");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects non-image data URIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "awb-attachment-materializer-"));
    try {
      await expect(
        materializeAttachmentDataUri(
          {
            attachmentId: "file-1",
            dataUri: "data:text/plain;base64,SGVsbG8=",
            mimeType: "text/plain",
            name: "note.txt"
          },
          root
        )
      ).rejects.toThrow("not an image");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
