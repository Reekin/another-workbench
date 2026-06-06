import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TakeoverPresetStore } from "../src/takeover-preset-store.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-takeover-presets-"));
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

describe("TakeoverPresetStore", () => {
  it("initializes built-in presets and writes custom prompts under the takeover directory", async () => {
    const baseDir = await createTempDir();
    const store = new TakeoverPresetStore({ baseDir });

    const initial = await store.list();
    expect(initial.rootPath).toBe(join(baseDir, "takeover"));
    expect(initial.presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          presetId: "progress",
          kind: "directory",
          desc: expect.stringContaining("checking the development progress")
        }),
        expect.objectContaining({
          presetId: "review",
          kind: "directory",
          desc: expect.stringContaining("Delegated reviewer")
        })
      ])
    );

    const custom = await store.upsert({
      presetId: "team_review",
      prompt: "desc: Custom team review\n\ncustom prompt"
    });

    expect(custom.promptPath).toBe(
      join(baseDir, "takeover", "team_review", "prompt.md")
    );
    expect(custom.desc).toBe("Custom team review");
    await expect(stat(custom.promptPath)).resolves.toMatchObject({
      isFile: expect.any(Function)
    });
  });

  it("rejects preset ids that could escape or alias the takeover directory", async () => {
    const baseDir = await createTempDir();
    const store = new TakeoverPresetStore({ baseDir });
    const invalidIds = [".", "..", "...", "a.b", "-dash", "_under"];

    for (const presetId of invalidIds) {
      await expect(
        store.upsert({
          presetId,
          prompt: "unsafe"
        })
      ).rejects.toThrow(/Takeover preset names/);
      await expect(store.delete(presetId)).rejects.toThrow(
        /Takeover preset names/
      );
    }

    await expect(stat(join(baseDir, "prompt.md"))).rejects.toThrow();
  });

  it("does not overwrite existing built-in preset prompt files", async () => {
    const baseDir = await createTempDir();
    const progressDir = join(baseDir, "takeover", "progress");
    const reviewDir = join(baseDir, "takeover", "review");
    await mkdir(progressDir, { recursive: true });
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(progressDir, "prompt.md"), "custom progress prompt", "utf8");
    await writeFile(
      join(reviewDir, "prompt.md"),
      "custom review prompt",
      "utf8"
    );

    const store = new TakeoverPresetStore({ baseDir });
    await store.list();

    await expect(readFile(join(progressDir, "prompt.md"), "utf8")).resolves.toBe(
      "custom progress prompt"
    );
    await expect(readFile(join(reviewDir, "prompt.md"), "utf8")).resolves.toBe(
      "custom review prompt"
    );
  });

  it("copies a built-in prompt when the preset directory has no markdown prompt", async () => {
    const baseDir = await createTempDir();
    const reviewDir = join(baseDir, "takeover", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "notes.txt"), "not a prompt", "utf8");

    const store = new TakeoverPresetStore({ baseDir });
    await store.list();

    await expect(readFile(join(reviewDir, "prompt.md"), "utf8")).resolves.toContain(
      "desc: Delegated reviewer"
    );
    await expect(readFile(join(reviewDir, "prompt.md"), "utf8")).resolves.toContain(
      "# Review Takeover"
    );
    await expect(readFile(join(reviewDir, "notes.txt"), "utf8")).resolves.toBe(
      "not a prompt"
    );
  });
});
