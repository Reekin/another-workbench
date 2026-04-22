import { spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { parseUnifiedDiff, type UnifiedDiffFile } from "@another-workbench/shared";

export type TurnChangeUndoResult = {
  undone: boolean;
  errorMessage?: string;
};

export type TurnChangeServiceOptions = {
  runGitApply?: (input: {
    cwd: string;
    diff: string;
    reverse?: boolean;
    check?: boolean;
  }) => Promise<TurnChangeUndoResult>;
};

const runGitApply = async (input: {
  cwd: string;
  diff: string;
  reverse?: boolean;
  check?: boolean;
}): Promise<TurnChangeUndoResult> =>
  new Promise((resolve) => {
    const args = ["apply"];
    if (input.reverse) {
      args.push("--reverse");
    }
    if (input.check) {
      args.push("--check");
    }
    args.push("--whitespace=nowarn", "-");

    const child = spawn("git", args, {
      cwd: input.cwd,
      stdio: ["pipe", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        undone: false,
        errorMessage: error.message
      });
    });
    child.on("close", (code) => {
      resolve(
        code === 0
          ? {
              undone: true
            }
          : {
              undone: false,
              errorMessage:
                stderr.trim() || `git apply exited with code ${code ?? "unknown"}`
            }
      );
    });
    child.stdin.end(input.diff);
  });

const stripWindowsDevicePrefix = (value: string): string =>
  value.replace(/^\\\\\?\\/, "");

const normalizePatchPathForGitApply = (
  rawPath: string | undefined,
  cwd: string
): string | undefined => {
  if (!rawPath || rawPath === "/dev/null") {
    return undefined;
  }
  const stripped = stripWindowsDevicePrefix(rawPath);
  const normalized = stripped.replaceAll("\\", "/");
  if (!isAbsolute(stripped)) {
    return normalized;
  }
  const relativePath = relative(cwd, stripped);
  if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return normalized;
  }
  return relativePath.replaceAll("\\", "/");
};

const serializeUnifiedDiffFile = (file: UnifiedDiffFile, cwd: string): string | undefined => {
  const oldPath = normalizePatchPathForGitApply(file.oldPath, cwd);
  const newPath = normalizePatchPathForGitApply(file.newPath, cwd);
  const diffPath = newPath ?? oldPath;
  if (!diffPath) {
    return undefined;
  }
  const oldHeader = oldPath ? `a/${oldPath}` : "/dev/null";
  const newHeader = newPath ? `b/${newPath}` : "/dev/null";
  const oldDiffPath = oldPath ?? diffPath;
  const newDiffPath = newPath ?? diffPath;

  return [
    `diff --git a/${oldDiffPath} b/${newDiffPath}`,
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => line.text)])
  ].join("\n");
};

const canonicalizeDiffForGitApply = (diff: string, cwd: string): string => {
  const parsed = parseUnifiedDiff(diff);
  if (parsed.length === 0) {
    return diff.trim();
  }
  const serialized = parsed
    .map((file) => serializeUnifiedDiffFile(file, cwd))
    .filter((fileDiff): fileDiff is string => Boolean(fileDiff));
  if (serialized.length === 0) {
    return diff.trim();
  }
  return `${serialized.join("\n")}\n`;
};

export class TurnChangeService {
  private readonly runGitApplyImpl: NonNullable<TurnChangeServiceOptions["runGitApply"]>;

  public constructor(options: TurnChangeServiceOptions = {}) {
    this.runGitApplyImpl = options.runGitApply ?? runGitApply;
  }

  public async undoTurnChanges(input: {
    cwd: string;
    diff: string;
  }): Promise<TurnChangeUndoResult> {
    const diff = canonicalizeDiffForGitApply(input.diff, input.cwd);
    if (!diff) {
      return {
        undone: false,
        errorMessage: "No file changes were recorded for this turn."
      };
    }

    const checkResult = await this.runGitApplyImpl({
      cwd: input.cwd,
      diff,
      reverse: true,
      check: true
    });
    if (!checkResult.undone) {
      return checkResult;
    }

    return this.runGitApplyImpl({
      cwd: input.cwd,
      diff,
      reverse: true
    });
  }
}
