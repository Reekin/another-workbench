import { useMemo, type ReactElement } from "react";
import type { CodexHookRunRpc } from "@another-workbench/shared";

export type CodexHookActivityExtensionProps = {
  runs: CodexHookRunRpc[];
};

const statusLabel = (run: CodexHookRunRpc): string =>
  run.durationMs != null && run.status !== "running"
    ? `${run.status} · ${run.durationMs}ms`
    : run.status;

const titleForRun = (run: CodexHookRunRpc): string =>
  `${run.eventName} · ${run.handlerType}`;

const detailForRun = (run: CodexHookRunRpc): string =>
  [run.executionMode, run.scope, run.source]
    .filter((value) => value.trim().length > 0)
    .join(" · ");

const outputTextForRun = (run: CodexHookRunRpc): string | undefined => {
  const lines = [
    ...(run.statusMessage ? [`status: ${run.statusMessage}`] : []),
    ...run.entries.map((entry) => `${entry.kind}: ${entry.text}`)
  ];
  const text = lines.join("\n").trim();
  return text || undefined;
};

export const CodexHookActivityExtension = ({
  runs
}: CodexHookActivityExtensionProps): ReactElement | null => {
  const sortedRuns = useMemo(
    () =>
      [...runs].sort((left, right) => {
        if (left.startedAt !== right.startedAt) {
          return left.startedAt - right.startedAt;
        }
        if (left.displayOrder !== right.displayOrder) {
          return left.displayOrder - right.displayOrder;
        }
        return left.id.localeCompare(right.id);
      }),
    [runs]
  );

  if (sortedRuns.length === 0) {
    return null;
  }

  return (
    <section className="awb-hook-activity" aria-label="Hook activity">
      <header className="awb-hook-activity__header">
        <strong>Hook activity</strong>
        <span>{sortedRuns.length} runs</span>
      </header>
      <div className="awb-hook-activity__list">
        {sortedRuns.map((run) => {
          const outputText = outputTextForRun(run);
          return (
            <details
              key={run.id}
              className="awb-hook-activity__run"
              open={run.status === "running" || run.status === "failed"}
            >
              <summary className="awb-hook-activity__summary">
                <span className="awb-hook-activity__title">{titleForRun(run)}</span>
                <span className={`awb-hook-activity__status is-${run.status}`}>
                  {statusLabel(run)}
                </span>
              </summary>
              <div className="awb-hook-activity__body">
                <div className="awb-hook-activity__meta">
                  <span>{detailForRun(run)}</span>
                  <code>{run.sourcePath}</code>
                </div>
                {outputText ? (
                  <pre className="awb-hook-activity__output">{outputText}</pre>
                ) : (
                  <p className="awb-hook-activity__empty">No hook output.</p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
};
