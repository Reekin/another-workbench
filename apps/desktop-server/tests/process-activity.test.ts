import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  summarizeCodexImageGenerationOutput,
  summarizeCodexImageViewOutput
} from "../src/engine-extensions/codex/process-activity.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-process-activity-"));
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

describe("codex process activity image summaries", () => {
  it("versions imageView file URLs with modified time and size", async () => {
    const dir = await createTempDir();
    const imagePath = join(dir, "same-size.png");
    await writeFile(imagePath, "AAAA");
    await utimes(imagePath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    const firstSummary = summarizeCodexImageViewOutput({
      type: "imageView",
      id: "image-1",
      path: imagePath
    });

    await writeFile(imagePath, "BBBB");
    await utimes(imagePath, new Date("2026-01-01T01:00:00.000Z"), new Date("2026-01-01T01:00:00.000Z"));

    const secondSummary = summarizeCodexImageViewOutput({
      type: "imageView",
      id: "image-1",
      path: imagePath
    });

    expect(firstSummary).toContain("![Viewed image](file:");
    expect(firstSummary).toContain("awb_file_mtime=");
    expect(firstSummary).toContain("awb_file_size=4");
    expect(firstSummary).toContain(`path: ${imagePath}`);
    expect(secondSummary).toContain("awb_file_size=4");
    expect(secondSummary).toContain(`path: ${imagePath}`);
    expect(firstSummary).not.toBe(secondSummary);
  });

  it("versions imageGeneration savedPath file URLs", async () => {
    const dir = await createTempDir();
    const imagePath = join(dir, "generated.png");
    await writeFile(imagePath, "PNG!");
    await utimes(imagePath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    const summary = summarizeCodexImageGenerationOutput({
      type: "imageGeneration",
      id: "image-generation-1",
      status: "completed",
      revisedPrompt: "A dashboard",
      result: "",
      savedPath: imagePath
    });

    expect(summary).toContain("![Generated image](file:");
    expect(summary).toContain("awb_file_mtime=");
    expect(summary).toContain("awb_file_size=4");
    expect(summary).toContain(`path: ${imagePath}`);
  });
});
