import { useEffect, useState } from "react";
import type {
  BackgroundRunSnapshotRpc,
  CheckpointSnapshotRpc,
  DiagnosticsSnapshotRpc,
  WorktreeSnapshotRpc
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ComposerStatusNotice } from "./composer-status.js";

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export const useSessionSummaryController = (input: {
  transport?: DesktopTransport;
  browsedSessionId?: string;
  eventCursor?: string;
  onStatusNotice: StatusNoticeSetter;
}): {
  worktree: WorktreeSnapshotRpc | undefined;
  checkpoint: CheckpointSnapshotRpc | undefined;
  diagnostics: DiagnosticsSnapshotRpc | undefined;
  backgroundRun: BackgroundRunSnapshotRpc | undefined;
} => {
  const [worktree, setWorktree] = useState<WorktreeSnapshotRpc | undefined>();
  const [checkpoint, setCheckpoint] = useState<CheckpointSnapshotRpc | undefined>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshotRpc | undefined>();
  const [backgroundRun, setBackgroundRun] = useState<
    BackgroundRunSnapshotRpc | undefined
  >();

  useEffect(() => {
    if (!input.transport || !input.browsedSessionId) {
      setWorktree(undefined);
      setCheckpoint(undefined);
      setDiagnostics(undefined);
      setBackgroundRun(undefined);
      return;
    }

    let disposed = false;
    void Promise.all([
      input.transport.worktree.get(input.browsedSessionId),
      input.transport.checkpoint.get(input.browsedSessionId),
      input.transport.diagnostics.get(input.browsedSessionId),
      input.transport.backgroundRun.get(input.browsedSessionId)
    ])
      .then(([nextWorktree, nextCheckpoint, nextDiagnostics, nextBackgroundRun]) => {
        if (disposed) {
          return;
        }
        setWorktree(nextWorktree);
        setCheckpoint(nextCheckpoint);
        setDiagnostics(nextDiagnostics);
        setBackgroundRun(nextBackgroundRun);
      })
      .catch((error) => {
        if (!disposed) {
          input.onStatusNotice({
            message: `Session summaries failed: ${(error as Error).message}`,
            source: "session-browser"
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [input.transport, input.browsedSessionId, input.eventCursor]);

  return {
    worktree,
    checkpoint,
    diagnostics,
    backgroundRun
  };
};
