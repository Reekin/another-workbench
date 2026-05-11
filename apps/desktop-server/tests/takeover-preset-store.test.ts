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

const oldProgressPresetPrompt = `# Progress Takeover

You are the takeover progress manager for the parent agent session.

Compare the current state against the stated roadmap, brief, and acceptance criteria. Identify what is complete, what is missing, and the next concrete work needed. If the task is not complete, send it back with a focused continuation request. If the task is complete, approve it.

Use the SubmitTakeoverVerdict tool exactly once:
- verdict: "incomplete" when the parent agent must keep developing
- verdict: "complete" when the stated goal is complete
- response: your complete virtual-user reply to the parent agent

Keep the verdict grounded in observable workspace state and acceptance criteria.
`;

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

  it("migrates the old built-in progress preset without touching custom prompts", async () => {
    const baseDir = await createTempDir();
    const progressDir = join(baseDir, "takeover", "progress");
    const reviewDir = join(baseDir, "takeover", "review");
    await mkdir(progressDir, { recursive: true });
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(progressDir, "prompt.md"), oldProgressPresetPrompt, "utf8");
    await writeFile(
      join(reviewDir, "prompt.md"),
      "custom review prompt",
      "utf8"
    );

    const store = new TakeoverPresetStore({ baseDir });
    await store.list();

    await expect(readFile(join(progressDir, "prompt.md"), "utf8")).resolves.toContain(
      "roadmap, task context, and acceptance criteria"
    );
    await expect(readFile(join(reviewDir, "prompt.md"), "utf8")).resolves.toBe(
      "custom review prompt"
    );
  });
});
