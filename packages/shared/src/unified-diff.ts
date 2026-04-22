export type UnifiedDiffLineKind = "context" | "add" | "delete";

export type UnifiedDiffLine = {
  kind: UnifiedDiffLineKind;
  text: string;
};

export type UnifiedDiffHunk = {
  header: string;
  lines: UnifiedDiffLine[];
};

export type UnifiedDiffFile = {
  oldPath?: string;
  newPath?: string;
  displayPath: string;
  linesAdded: number;
  linesDeleted: number;
  hunks: UnifiedDiffHunk[];
};

export type UnifiedDiffSummary = {
  fileCount: number;
  linesAdded: number;
  linesDeleted: number;
  files: UnifiedDiffFile[];
};

type MutableUnifiedDiffFile = {
  oldPath?: string;
  newPath?: string;
  displayPath?: string;
  linesAdded: number;
  linesDeleted: number;
  hunks: UnifiedDiffHunk[];
};

const stripGitPrefix = (value: string | undefined): string | undefined => {
  if (!value || value === "/dev/null") {
    return undefined;
  }
  return value.replace(/^[ab]\//, "");
};

const createMutableFile = (): MutableUnifiedDiffFile => ({
  linesAdded: 0,
  linesDeleted: 0,
  hunks: []
});

const finalizeFile = (
  files: UnifiedDiffFile[],
  current: MutableUnifiedDiffFile | undefined
): void => {
  if (!current) {
    return;
  }
  const displayPath =
    current.displayPath ??
    current.newPath ??
    current.oldPath ??
    "Unnamed change";
  files.push({
    oldPath: current.oldPath,
    newPath: current.newPath,
    displayPath,
    linesAdded: current.linesAdded,
    linesDeleted: current.linesDeleted,
    hunks: current.hunks
  });
};

export const parseUnifiedDiff = (diff: string | undefined): UnifiedDiffFile[] => {
  if (!diff || diff.trim().length === 0) {
    return [];
  }

  const files: UnifiedDiffFile[] = [];
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  let current: MutableUnifiedDiffFile | undefined;
  let currentHunk: UnifiedDiffHunk | undefined;

  const commitCurrent = (): void => {
    finalizeFile(files, current);
    current = undefined;
    currentHunk = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      commitCurrent();
      current = createMutableFile();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match) {
        current.oldPath = match[1];
        current.newPath = match[2];
        current.displayPath = stripGitPrefix(match[2]) ?? stripGitPrefix(match[1]);
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      current ??= createMutableFile();
      current.oldPath = stripGitPrefix(line.slice(4).trim());
      if (!current.displayPath) {
        current.displayPath = current.oldPath;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      current ??= createMutableFile();
      current.newPath = stripGitPrefix(line.slice(4).trim());
      current.displayPath = current.newPath ?? current.oldPath;
      continue;
    }

    if (line.startsWith("@@")) {
      current ??= createMutableFile();
      currentHunk = {
        header: line,
        lines: []
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!current || !currentHunk) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.linesAdded += 1;
      currentHunk.lines.push({
        kind: "add",
        text: line
      });
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      current.linesDeleted += 1;
      currentHunk.lines.push({
        kind: "delete",
        text: line
      });
      continue;
    }

    currentHunk.lines.push({
      kind: "context",
      text: line
    });
  }

  commitCurrent();
  return files;
};

export const summarizeUnifiedDiff = (
  diff: string | undefined
): UnifiedDiffSummary => {
  const files = parseUnifiedDiff(diff);
  return {
    fileCount: files.length,
    linesAdded: files.reduce((total, file) => total + file.linesAdded, 0),
    linesDeleted: files.reduce((total, file) => total + file.linesDeleted, 0),
    files
  };
};
