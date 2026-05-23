import type { CodexHookRunRpc } from "@another-workbench/shared";

export type RecordedCodexHookRun = CodexHookRunRpc;

export type RecordedCodexHookActivity = {
  sessionId: string;
  turnId: string;
  runs: RecordedCodexHookRun[];
};

const recordsBySessionId = new Map<string, Map<string, RecordedCodexHookActivity>>();

const cloneRun = (run: RecordedCodexHookRun): RecordedCodexHookRun => ({
  ...run,
  entries: run.entries.map((entry) => ({ ...entry }))
});

const cloneActivity = (
  activity: RecordedCodexHookActivity
): RecordedCodexHookActivity => ({
  sessionId: activity.sessionId,
  turnId: activity.turnId,
  runs: activity.runs.map(cloneRun)
});

const sortRuns = (runs: RecordedCodexHookRun[]): RecordedCodexHookRun[] =>
  [...runs].sort((left, right) => {
    if (left.startedAt !== right.startedAt) {
      return left.startedAt - right.startedAt;
    }
    if (left.displayOrder !== right.displayOrder) {
      return left.displayOrder - right.displayOrder;
    }
    return left.id.localeCompare(right.id);
  });

export const clearCodexHookActivityStore = (): void => {
  recordsBySessionId.clear();
};

export const clearRecordedCodexHookActivityForSession = (sessionId: string): void => {
  recordsBySessionId.delete(sessionId);
};

export const getRecordedCodexHookActivity = (
  sessionId: string,
  turnId: string
): RecordedCodexHookActivity | undefined => {
  const record = recordsBySessionId.get(sessionId)?.get(turnId);
  return record ? cloneActivity(record) : undefined;
};

export const recordCodexHookRun = (input: {
  sessionId: string;
  turnId: string;
  run: RecordedCodexHookRun;
}): RecordedCodexHookActivity => {
  const sessionRecords =
    recordsBySessionId.get(input.sessionId) ??
    new Map<string, RecordedCodexHookActivity>();
  const current = sessionRecords.get(input.turnId);
  const existingRuns = current?.runs ?? [];
  const nextRuns = sortRuns([
    ...existingRuns.filter((run) => run.id !== input.run.id),
    cloneRun(input.run)
  ]);
  const next = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runs: nextRuns
  };
  sessionRecords.set(input.turnId, next);
  recordsBySessionId.set(input.sessionId, sessionRecords);
  return cloneActivity(next);
};

export class CodexHookActivityStore {
  public record(input: {
    sessionId: string;
    turnId: string;
    run: RecordedCodexHookRun;
  }): RecordedCodexHookActivity {
    return recordCodexHookRun(input);
  }

  public get(
    sessionId: string,
    turnId: string
  ): RecordedCodexHookActivity | undefined {
    return getRecordedCodexHookActivity(sessionId, turnId);
  }
}
