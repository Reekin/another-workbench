import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePreviewService } from "../src/file-preview-service.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-file-preview-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("FilePreviewService", () => {
  it("includes modified time for image previews", async () => {
    const dir = await createTempDir();
    const imagePath = join(dir, "diagram.png");
    const modifiedAt = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(imagePath, "PNG!");
    await utimes(imagePath, modifiedAt, modifiedAt);

    const preview = await new FilePreviewService().getPreview(imagePath);

    expect(preview).toMatchObject({
      kind: "image",
      exists: true,
      fileSizeBytes: 4,
      imageUrl: expect.stringMatching(/^file:/)
    });
    expect(preview.kind === "image" ? preview.modifiedAtMs : undefined).toBeGreaterThan(0);
  });
});
