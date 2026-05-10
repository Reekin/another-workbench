import { mkdtemp, rm, stat } from "node:fs/promises";
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
        expect.objectContaining({ presetId: "progress", kind: "directory" }),
        expect.objectContaining({ presetId: "review", kind: "directory" })
      ])
    );

    const custom = await store.upsert({
      presetId: "team_review",
      prompt: "custom prompt"
    });

    expect(custom.promptPath).toBe(
      join(baseDir, "takeover", "team_review", "prompt.md")
    );
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
});

