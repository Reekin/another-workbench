import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const builtinPresetIds = ["review", "progress"] as const;
type BuiltinPresetId = (typeof builtinPresetIds)[number];

const builtinPresetPromptPath = (presetId: BuiltinPresetId): string =>
  fileURLToPath(
    new URL(`./resources/takeover-presets/${presetId}/prompt.md`, import.meta.url)
  );

const builtinSystemResourcePath = (
  resourceName: "description.md" | "help.md"
): string =>
  fileURLToPath(
    new URL(`./resources/smart-takeover/${resourceName}`, import.meta.url)
  );

const displayNameFor = (presetId: string): string =>
  presetId
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || presetId;

const readPresetDesc = async (promptPath: string): Promise<string | undefined> => {
  const prompt = await readFile(promptPath, "utf8");
  const firstLine = prompt.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]?.trim();
  const match = firstLine?.match(/^desc:\s*(.+)$/i);
  return match?.[1]?.trim() || undefined;
};

const copyFileIfMissing = async (
  sourcePath: string,
  targetPath: string
): Promise<void> => {
  try {
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
};

const validatePresetId = (presetId: string): void => {
  if (!presetIdPattern.test(presetId)) {
    throw new Error(
      "Takeover preset names must start with a letter or number and may only contain letters, numbers, underscores, and hyphens."
    );
  }
};

export class TakeoverPresetStore {
  private readonly rootPath: string;
  private readonly systemResourcePath: string;
  private readyPromise: Promise<void> | undefined;

  public constructor(options: TakeoverPresetStoreOptions = {}) {
    this.rootPath = join(options.baseDir ?? defaultBaseDir(), "takeover");
    this.systemResourcePath = join(this.rootPath, "_system");
  }

  public getRootPath(): string {
    return this.rootPath;
  }

  public getSystemResourcePath(): string {
    return this.systemResourcePath;
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
          desc: await readPresetDesc(promptPath),
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

  public async readToolDescription(): Promise<string> {
    await this.ready();
    return (
      await readFile(join(this.systemResourcePath, "description.md"), "utf8")
    ).trim();
  }

  public async readHelp(): Promise<string> {
    await this.ready();
    return (
      await readFile(join(this.systemResourcePath, "help.md"), "utf8")
    ).trim();
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
      desc: await readPresetDesc(promptPath),
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
    await mkdir(this.systemResourcePath, { recursive: true });
    for (const resourceName of ["description.md", "help.md"] as const) {
      await copyFileIfMissing(
        builtinSystemResourcePath(resourceName),
        join(this.systemResourcePath, resourceName)
      );
    }
    for (const presetId of builtinPresetIds) {
      validatePresetId(presetId);
      if (await this.hasPresetPrompt(presetId)) {
        continue;
      }
      const directoryPath = this.resolvePresetDirectory(presetId);
      const promptPath = join(directoryPath, "prompt.md");
      await mkdir(directoryPath, { recursive: true });
      await copyFile(builtinPresetPromptPath(presetId), promptPath);
    }
  }

  private async hasPresetPrompt(presetId: string): Promise<boolean> {
    const directPromptPath = join(this.rootPath, `${presetId}.md`);
    try {
      if ((await stat(directPromptPath)).isFile()) {
        return true;
      }
    } catch {
      // Missing direct-file presets are expected for directory-backed presets.
    }

    try {
      const directoryPath = this.resolvePresetDirectory(presetId);
      const files = await readdir(directoryPath, { withFileTypes: true });
      return files.some(
        (entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md"
      );
    } catch {
      return false;
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
      desc: await readPresetDesc(promptPath),
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
