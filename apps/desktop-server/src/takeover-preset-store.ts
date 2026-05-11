import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  TakeoverPresetDocumentRpc,
  TakeoverPresetSummaryRpc
} from "@another-workbench/shared";

type Clock = () => string;

export type TakeoverPresetStoreOptions = {
  baseDir?: string;
  now?: Clock;
};

export type TakeoverPresetListResult = {
  rootPath: string;
  presets: TakeoverPresetSummaryRpc[];
};

const presetIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const defaultBaseDir = (): string => join(homedir(), ".another-workbench");

const legacyBuiltinPresets: Record<string, string> = {
  review: `# Review Takeover

You are the takeover reviewer for the parent agent session.

Act as the user's delegated reviewer. Inspect the current workspace and the parent session context. If the work has correctness, regression, maintainability, security, or test coverage issues, request concrete changes. If the work is ready, approve it.

Use the SubmitTakeoverVerdict tool exactly once:
- verdict: "incomplete" when the parent agent must continue working
- verdict: "complete" when the work is ready for the user
- response: your complete virtual-user reply to the parent agent

Your feedback should be specific enough for the parent agent to act without guessing.
`,
  progress: `# Progress Takeover

You are the takeover progress manager for the parent agent session.

Compare the current state against the stated roadmap, brief, and acceptance criteria. Identify what is complete, what is missing, and the next concrete work needed. If the task is not complete, send it back with a focused continuation request. If the task is complete, approve it.

Use the SubmitTakeoverVerdict tool exactly once:
- verdict: "incomplete" when the parent agent must keep developing
- verdict: "complete" when the stated goal is complete
- response: your complete virtual-user reply to the parent agent

Keep the verdict grounded in observable workspace state and acceptance criteria.
`
};

const builtinPresets: Record<string, string> = {
  review: `# Review Takeover

You are the user's delegated reviewer for this session.

Inspect the current workspace and the latest agent output. If the work has correctness, regression, maintainability, security, or test coverage issues, request concrete changes as the user. If the work is ready, approve it.

Use the SubmitTakeoverVerdict tool exactly once:
- verdict: "incomplete" when the agent must continue working from your response
- verdict: "complete" when the work is ready for the user
- response: your complete user-facing reply to send back to the agent

Your feedback should be specific enough for the agent to act without guessing.
`,
  progress: `# Progress Takeover

You are the user's delegated progress manager for this session.

Compare the current state against the stated roadmap, task context, and acceptance criteria. Identify what is complete, what is missing, and the next concrete work needed. If the task is not complete, send it back with a focused continuation request. If the task is complete, approve it.

Use the SubmitTakeoverVerdict tool exactly once:
- verdict: "incomplete" when the agent must keep developing from your response
- verdict: "complete" when the stated goal is complete
- response: your complete user-facing reply to send back to the agent

Keep the verdict grounded in observable workspace state and acceptance criteria.
`
};

const normalizePresetPrompt = (prompt: string): string =>
  prompt.replace(/\r\n/g, "\n").trimEnd();

const displayNameFor = (presetId: string): string =>
  presetId
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || presetId;

const validatePresetId = (presetId: string): void => {
  if (!presetIdPattern.test(presetId)) {
    throw new Error(
      "Takeover preset names must start with a letter or number and may only contain letters, numbers, underscores, and hyphens."
    );
  }
};

export class TakeoverPresetStore {
  private readonly rootPath: string;
  private readyPromise: Promise<void> | undefined;

  public constructor(options: TakeoverPresetStoreOptions = {}) {
    this.rootPath = join(options.baseDir ?? defaultBaseDir(), "takeover");
  }

  public getRootPath(): string {
    return this.rootPath;
  }

  public async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.ensureDefaults();
    }
    await this.readyPromise;
  }

  public async list(): Promise<TakeoverPresetListResult> {
    await this.ready();
    const presets: TakeoverPresetSummaryRpc[] = [];
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const summary = await this.readDirectorySummary(entry.name);
        if (summary) {
          presets.push(summary);
        }
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        const presetId = basename(entry.name, ".md");
        if (!presetIdPattern.test(presetId)) {
          continue;
        }
        const promptPath = join(this.rootPath, entry.name);
        const fileStat = await stat(promptPath);
        presets.push({
          presetId,
          displayName: displayNameFor(presetId),
          promptPath,
          kind: "file",
          updatedAt: fileStat.mtime.toISOString()
        });
      }
    }
    return {
      rootPath: this.rootPath,
      presets: presets.sort((left, right) =>
        left.presetId.localeCompare(right.presetId)
      )
    };
  }

  public async read(presetId: string): Promise<TakeoverPresetDocumentRpc> {
    validatePresetId(presetId);
    const summary = (await this.list()).presets.find(
      (preset) => preset.presetId === presetId
    );
    if (!summary) {
      throw new Error(`Takeover preset not found: ${presetId}`);
    }
    const prompt = await readFile(summary.promptPath, "utf8");
    return {
      ...summary,
      prompt
    };
  }

  public async upsert(input: {
    presetId: string;
    prompt: string;
    displayName?: string;
  }): Promise<TakeoverPresetDocumentRpc> {
    validatePresetId(input.presetId);
    await this.ready();
    const directoryPath = this.resolvePresetDirectory(input.presetId);
    await mkdir(directoryPath, { recursive: true });
    const promptPath = join(directoryPath, "prompt.md");
    await writeFile(promptPath, input.prompt, "utf8");
    const fileStat = await stat(promptPath);
    return {
      presetId: input.presetId,
      displayName: input.displayName ?? displayNameFor(input.presetId),
      promptPath,
      kind: "directory",
      updatedAt: fileStat.mtime.toISOString(),
      prompt: input.prompt
    };
  }

  public async delete(presetId: string): Promise<{ presetId: string; deleted: boolean }> {
    validatePresetId(presetId);
    const summary = (await this.list()).presets.find(
      (preset) => preset.presetId === presetId
    );
    if (!summary) {
      return { presetId, deleted: false };
    }
    if (summary.kind === "directory") {
      await rm(this.resolvePresetDirectory(presetId), { recursive: true, force: true });
    } else {
      await rm(summary.promptPath, { force: true });
    }
    return { presetId, deleted: true };
  }

  private async ensureDefaults(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    for (const [presetId, prompt] of Object.entries(builtinPresets)) {
      validatePresetId(presetId);
      const directoryPath = this.resolvePresetDirectory(presetId);
      const promptPath = join(directoryPath, "prompt.md");
      try {
        await stat(promptPath);
        const legacyPrompt = legacyBuiltinPresets[presetId];
        if (!legacyPrompt) {
          continue;
        }
        const existingPrompt = await readFile(promptPath, "utf8");
        if (
          normalizePresetPrompt(existingPrompt) ===
          normalizePresetPrompt(legacyPrompt)
        ) {
          await writeFile(promptPath, prompt, "utf8");
        }
      } catch {
        await mkdir(directoryPath, { recursive: true });
        await writeFile(promptPath, prompt, "utf8");
      }
    }
  }

  private async readDirectorySummary(
    presetId: string
  ): Promise<TakeoverPresetSummaryRpc | undefined> {
    if (!presetIdPattern.test(presetId)) {
      return undefined;
    }
    const directoryPath = this.resolvePresetDirectory(presetId);
    const files = await readdir(directoryPath, { withFileTypes: true });
    const markdownFiles = files
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
      .map((entry) => entry.name)
      .sort((left, right) => {
        if (left === "prompt.md") {
          return -1;
        }
        if (right === "prompt.md") {
          return 1;
        }
        return left.localeCompare(right);
      });
    const promptFile = markdownFiles[0];
    if (!promptFile) {
      return undefined;
    }
    const promptPath = join(directoryPath, promptFile);
    const fileStat = await stat(promptPath);
    return {
      presetId,
      displayName: displayNameFor(presetId),
      promptPath,
      kind: "directory",
      updatedAt: fileStat.mtime.toISOString()
    };
  }

  private resolvePresetDirectory(presetId: string): string {
    validatePresetId(presetId);
    const directoryPath = resolve(this.rootPath, presetId);
    this.assertInsideRoot(directoryPath);
    return directoryPath;
  }

  private assertInsideRoot(targetPath: string): void {
    const rootPath = resolve(this.rootPath);
    const relativePath = relative(rootPath, resolve(targetPath));
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      throw new Error("Takeover preset path must stay inside the takeover directory.");
    }
  }
}
