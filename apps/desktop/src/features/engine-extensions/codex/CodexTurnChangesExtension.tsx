import { useMemo, useState, type ReactElement } from "react";
import {
  summarizeUnifiedDiff,
  type CodexChangedFileRpc
} from "@another-workbench/shared";

export type CodexTurnChangesExtensionProps = {
  sessionId: string;
  turnId: string;
  changedFiles: CodexChangedFileRpc[];
  canUndo: boolean;
  onUndoTurn?: (input: {
    sessionId: string;
    turnId: string;
  }) => Promise<{
    undone: boolean;
    errorMessage?: string;
  }>;
};

const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

export const CodexTurnChangesExtension = ({
  sessionId,
  turnId,
  changedFiles,
  canUndo,
  onUndoTurn
}: CodexTurnChangesExtensionProps): ReactElement | null => {
  const mergedDiff = useMemo(
    () =>
      changedFiles
        .map((file) => file.diff?.trim())
        .filter((diff): diff is string => Boolean(diff))
        .join("\n"),
    [changedFiles]
  );
  const summary = useMemo(() => summarizeUnifiedDiff(mergedDiff), [mergedDiff]);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | undefined>();
  const [isUndone, setIsUndone] = useState(false);

  if (changedFiles.length === 0) {
    return null;
  }

  const toggleFile = (path: string): void => {
    setExpandedPaths((current) => ({
      ...current,
      [path]: !current[path]
    }));
  };

  const onUndo = async (): Promise<void> => {
    if (!onUndoTurn || isUndoing || isUndone) {
      return;
    }
    setIsUndoing(true);
    setUndoError(undefined);
    try {
      const result = await onUndoTurn({
        sessionId,
        turnId
      });
      if (!result.undone) {
        setUndoError(result.errorMessage ?? "Failed to revert this turn.");
        return;
      }
      setIsUndone(true);
    } catch (error) {
      setUndoError((error as Error).message);
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <section className="awb-turn-changes" aria-label="Changed files">
      <header className="awb-turn-changes__header">
        <div className="awb-turn-changes__summary">
          <strong>{pluralize(summary.fileCount, "file")} changed</strong>
          <span className="awb-turn-changes__totals">
            <span className="is-add">+{summary.linesAdded}</span>
            <span className="is-delete">-{summary.linesDeleted}</span>
          </span>
        </div>
        <button
          type="button"
          className="awb-ghost-button"
          onClick={() => void onUndo()}
          disabled={!onUndoTurn || !canUndo || isUndoing || isUndone}
        >
          {isUndone ? "Undone" : isUndoing ? "Undoing…" : canUndo ? "Undo" : "Undo unavailable"}
        </button>
      </header>
      {undoError ? <p className="awb-turn-changes__notice is-error">{undoError}</p> : null}
      {isUndone ? (
        <p className="awb-turn-changes__notice">Turn changes were reverted locally.</p>
      ) : null}
      <div className="awb-turn-changes__list">
        {changedFiles.map((file) => {
          const isExpanded = expandedPaths[file.displayPath] ?? false;
          const fileSummary = summarizeUnifiedDiff(file.diff);
          return (
            <article key={file.displayPath} className="awb-turn-changes__file">
              <button
                type="button"
                className="awb-turn-changes__file-toggle"
                onClick={() => toggleFile(file.displayPath)}
                aria-expanded={isExpanded}
              >
                <span className="awb-turn-changes__file-path">{file.displayPath}</span>
                <span className="awb-turn-changes__file-stats">
                  <span className="is-add">+{fileSummary.linesAdded}</span>
                  <span className="is-delete">-{fileSummary.linesDeleted}</span>
                </span>
              </button>
              {isExpanded && fileSummary.files[0] ? (
                <div className="awb-turn-changes__diff">
                  {fileSummary.files[0].hunks.map((hunk) => (
                    <section
                      key={`${file.displayPath}:${hunk.header}`}
                      className="awb-turn-changes__hunk"
                    >
                      <div className="awb-turn-changes__hunk-header">{hunk.header}</div>
                      <pre className="awb-turn-changes__hunk-body">
                        {hunk.lines.map((line, index) => (
                          <div
                            key={`${file.displayPath}:${hunk.header}:${index}`}
                            className={`awb-turn-changes__line is-${line.kind}`}
                          >
                            {line.text || " "}
                          </div>
                        ))}
                      </pre>
                    </section>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
};
