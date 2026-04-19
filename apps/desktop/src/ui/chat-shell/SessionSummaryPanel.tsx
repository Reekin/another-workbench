import type {
  BackgroundRunSnapshotRpc,
  CheckpointSnapshotRpc,
  DiagnosticsSnapshotRpc,
  WorktreeSnapshotRpc
} from "@another-workbench/shared";
import type { ReactElement } from "react";

const renderValue = (value: string | undefined): string => value ?? "-";

export const SessionSummaryPanel = (input: {
  worktree?: WorktreeSnapshotRpc;
  checkpoint?: CheckpointSnapshotRpc;
  diagnostics?: DiagnosticsSnapshotRpc;
  backgroundRun?: BackgroundRunSnapshotRpc;
}): ReactElement => {
  const currentCheckpoint = input.checkpoint?.checkpoints.find(
    (entry) => entry.isCurrent
  );

  return (
    <section className="awb-summary-panel">
      <article className="awb-summary-card">
        <header>
          <h3>Worktree</h3>
        </header>
        <dl>
          <div>
            <dt>Root</dt>
            <dd>{renderValue(input.worktree?.workspaceRoot)}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{renderValue(input.worktree?.gitBranch)}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>{renderValue(input.worktree?.gitSha)}</dd>
          </div>
        </dl>
      </article>

      <article className="awb-summary-card">
        <header>
          <h3>Checkpoint</h3>
        </header>
        <dl>
          <div>
            <dt>Current</dt>
            <dd>{renderValue(currentCheckpoint?.label)}</dd>
          </div>
          <div>
            <dt>Count</dt>
            <dd>{String(input.checkpoint?.checkpoints.length ?? 0)}</dd>
          </div>
          <div>
            <dt>Restore</dt>
            <dd>{input.checkpoint?.supportsRestore ? "available" : "unavailable"}</dd>
          </div>
        </dl>
      </article>

      <article className="awb-summary-card">
        <header>
          <h3>Diagnostics</h3>
        </header>
        <dl>
          <div>
            <dt>Auth</dt>
            <dd>{input.diagnostics?.authenticated ? "connected" : "not connected"}</dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{renderValue(input.diagnostics?.authMethod ?? undefined)}</dd>
          </div>
          <div>
            <dt>Summary</dt>
            <dd>{renderValue(input.diagnostics?.summaryText)}</dd>
          </div>
        </dl>
      </article>

      <article className="awb-summary-card">
        <header>
          <h3>Background Run</h3>
        </header>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>{renderValue(input.backgroundRun?.status)}</dd>
          </div>
          <div>
            <dt>Resume</dt>
            <dd>{renderValue(input.backgroundRun?.resumeToken)}</dd>
          </div>
        </dl>
      </article>
    </section>
  );
};
