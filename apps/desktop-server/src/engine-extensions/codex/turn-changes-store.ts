import { parseUnifiedDiff } from "@another-workbench/shared";
import type { FileUpdateChange } from "../../codex-app-server-generated/v2/FileUpdateChange.js";
import { mergeFileChangeDiffs, normalizeFileChangeDiff } from "../../file-change-diff.js";

export type CodexTurnChangeKind = "add" | "delete" | "update";

export type RecordedCodexTurnChange = {
  path: string;
  changeKind: CodexTurnChangeKind;
  diff?: string;
};

export type RecordedCodexTurnChanges = {
  sessionId: string;
  turnId: string;
  changes: RecordedCodexTurnChange[];
  mergedDiff?: string;
};

const recordsBySessionId = new Map<string, Map<string, RecordedCodexTurnChanges>>();

const trimToUndefined = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const serializeParsedUnifiedDiffFile = (file: {
  oldPath?: string;
  newPath?: string;
  hunks: Array<{
    header: string;
    lines: Array<{
      text: string;
    }>;
  }>;
}): string | undefined => {
  const oldPath = file.oldPath;
  const newPath = file.newPath;
  const diffPath = newPath ?? oldPath;
  if (!diffPath) {
    return undefined;
  }
  return [
    `diff --git a/${oldPath ?? diffPath} b/${newPath ?? diffPath}`,
    `--- ${oldPath ? `a/${oldPath}` : "/dev/null"}`,
    `+++ ${newPath ? `b/${newPath}` : "/dev/null"}`,
    ...file.hunks.flatMap((hunk) => [
      hunk.header,
      ...hunk.lines.map((line) => line.text)
    ])
  ].join("\n");
};

const changeKindFromPaths = (
  oldPath: string | undefined,
  newPath: string | undefined
): CodexTurnChangeKind => {
  if (!oldPath) {
    return "add";
  }
  if (!newPath) {
    return "delete";
  }
  return "update";
};

const normalizeChangeSet = (
  changes: readonly RecordedCodexTurnChange[]
): RecordedCodexTurnChange[] => {
  const byPath = new Map<string, RecordedCodexTurnChange>();
  for (const change of changes) {
    const normalizedPath = change.path.replaceAll("\\", "/").toLowerCase();
    byPath.set(normalizedPath, {
      path: change.path,
      changeKind: change.changeKind,
      diff: trimToUndefined(change.diff)
    });
  }
  return [...byPath.values()];
};

export const clearCodexTurnChangesStore = (): void => {
  recordsBySessionId.clear();
};

export const clearRecordedCodexTurnChangesForSession = (
  sessionId: string
): void => {
  recordsBySessionId.delete(sessionId);
};

export const getRecordedCodexTurnChanges = (
  sessionId: string,
  turnId: string
): RecordedCodexTurnChanges | undefined => {
  const record = recordsBySessionId.get(sessionId)?.get(turnId);
  if (!record) {
    return undefined;
  }
  return {
    ...record,
    changes: [...record.changes]
  };
};

export const recordCodexTurnChanges = (input: RecordedCodexTurnChanges): void => {
  const changes = normalizeChangeSet(
    input.changes.filter((change) => change.path.trim().length > 0)
  );
  const mergedDiff = trimToUndefined(input.mergedDiff);
  const sessionRecords =
    recordsBySessionId.get(input.sessionId) ??
    new Map<string, RecordedCodexTurnChanges>();

  if (changes.length === 0 && !mergedDiff) {
    sessionRecords.delete(input.turnId);
    if (sessionRecords.size === 0) {
      recordsBySessionId.delete(input.sessionId);
    } else {
      recordsBySessionId.set(input.sessionId, sessionRecords);
    }
    return;
  }

  sessionRecords.set(input.turnId, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    changes,
    mergedDiff
  });
  recordsBySessionId.set(input.sessionId, sessionRecords);
};

export const recordCodexTurnChangesFromFileUpdate = (input: {
  sessionId: string;
  turnId: string;
  changes: readonly FileUpdateChange[];
}): void => {
  recordCodexTurnChanges({
    sessionId: input.sessionId,
    turnId: input.turnId,
    changes: input.changes.map((change) => ({
      path: change.path,
      changeKind: change.kind.type,
      diff: normalizeFileChangeDiff(change)
    })),
    mergedDiff: mergeFileChangeDiffs(input.changes)
  });
};

export const recordCodexTurnChangesFromUnifiedDiff = (input: {
  sessionId: string;
  turnId: string;
  diff: string;
}): void => {
  const mergedDiff = trimToUndefined(input.diff);
  if (!mergedDiff) {
    recordCodexTurnChanges({
      sessionId: input.sessionId,
      turnId: input.turnId,
      changes: [],
      mergedDiff: undefined
    });
    return;
  }

  const parsed = parseUnifiedDiff(mergedDiff);
  recordCodexTurnChanges({
    sessionId: input.sessionId,
    turnId: input.turnId,
    changes: parsed.map((file) => ({
      path: file.newPath ?? file.oldPath ?? "",
      changeKind: changeKindFromPaths(file.oldPath, file.newPath),
      diff: trimToUndefined(serializeParsedUnifiedDiffFile(file))
    })),
    mergedDiff
  });
};

export class CodexTurnChangesStore {
  public constructor(_options: { now?: () => string } = {}) {}

  public record(input: {
    sessionId: string;
    turnId: string;
    changes?: RecordedCodexTurnChange[];
    mergedDiff?: string;
  }): RecordedCodexTurnChanges | undefined {
    recordCodexTurnChanges({
      sessionId: input.sessionId,
      turnId: input.turnId,
      changes: input.changes ?? [],
      mergedDiff: input.mergedDiff
    });
    return getRecordedCodexTurnChanges(input.sessionId, input.turnId);
  }

  public get(
    sessionId: string,
    turnId: string
  ): RecordedCodexTurnChanges | undefined {
    return getRecordedCodexTurnChanges(sessionId, turnId);
  }
}
