import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";
import type {
  ExtractedFileReference,
  FilePreviewRpc,
  WorkspaceFileSearchResultRpc
} from "@another-workbench/shared";

type FileSelection = ExtractedFileReference | WorkspaceFileSearchResultRpc;

const defaultPreviewHeight = 248;
const minPreviewHeight = 168;
const minResultsHeight = 180;

export type FilesDetailPanelProps = {
  workspaceLabel?: string;
  hasWorkspace: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  isSearching: boolean;
  searchResults: WorkspaceFileSearchResultRpc[];
  selectedFile?: FileSelection;
  preview?: FilePreviewRpc;
  isLoadingPreview: boolean;
  onSelectFile: (reference: FileSelection) => void;
  onRunFileAction: (input: {
    path: string;
    action: "open" | "reveal";
  }) => void;
  onOpenImage: (input: { src: string; alt: string }) => void;
};

const renderPreviewBody = (
  selectedFile: FileSelection | undefined,
  preview: FilePreviewRpc | undefined,
  onOpenImage: FilesDetailPanelProps["onOpenImage"]
): ReactElement => {
  if (!selectedFile) {
    return <></>;
  }

  if (!preview) {
    return (
      <div className="awb-files-panel__empty">
        <h4>{selectedFile.fileName}</h4>
        <p>Preview is not available yet. Try reopening the file or using Open/Reveal.</p>
      </div>
    );
  }

  switch (preview.kind) {
    case "image":
      return (
        <button
          type="button"
          className="awb-files-panel__image-preview"
          onClick={() =>
            onOpenImage({
              src: preview.imageUrl,
              alt: preview.target.label
            })
          }
        >
          <img src={preview.imageUrl} alt={preview.target.label} />
        </button>
      );
    case "text":
    case "code":
      return (
        <pre className="awb-files-panel__text-preview">
          <code>{preview.text}</code>
        </pre>
      );
    case "unsupported":
    case "missing":
    case "error":
      return (
        <div className="awb-files-panel__empty">
          <h4>{preview.target.fileName}</h4>
          <p>{preview.reason}</p>
        </div>
      );
  }
};

const isSelected = (selectedFile: FileSelection | undefined, path: string): boolean =>
  selectedFile?.path === path;

export const FilesDetailPanel = ({
  workspaceLabel,
  hasWorkspace,
  query,
  onQueryChange,
  isSearching,
  searchResults,
  selectedFile,
  preview,
  isLoadingPreview,
  onSelectFile,
  onRunFileAction,
  onOpenImage
}: FilesDetailPanelProps): ReactElement => {
  const containerRef = useRef<HTMLElement | null>(null);
  const [previewHeight, setPreviewHeight] = useState(defaultPreviewHeight);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const maxPreviewHeight = Math.max(
      minPreviewHeight,
      Math.floor(window.innerHeight * 0.58)
    );
    setPreviewHeight((current) => Math.min(current, maxPreviewHeight));
  }, []);

  const onResizeStart = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const startY = event.clientY;
    const startPreviewHeight = previewHeight;
    const containerRect = container.getBoundingClientRect();
    const maxPreviewHeight = Math.max(
      minPreviewHeight,
      containerRect.height - minResultsHeight - 76
    );

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const deltaY = startY - moveEvent.clientY;
      const nextPreviewHeight = Math.min(
        maxPreviewHeight,
        Math.max(minPreviewHeight, startPreviewHeight + deltaY)
      );
      setPreviewHeight(nextPreviewHeight);
    };

    const onPointerUp = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const previewStyle = {
    "--awb-files-preview-height": `${previewHeight}px`
  } as CSSProperties;

  return (
    <section className="awb-files-panel" ref={containerRef} style={previewStyle}>
      <header className="awb-files-panel__header">
        <div>
          <span className="awb-main__eyebrow">Files</span>
          <h3>{workspaceLabel ?? "Workspace files"}</h3>
          {selectedFile && (
            <p className="awb-files-panel__selection-path">{selectedFile.displayPath}</p>
          )}
        </div>
        <label className="awb-files-panel__search">
          <span className="awb-visually-hidden">Search workspace files</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={
              hasWorkspace
                ? "Search files in the active workspace"
                : "Select a workspace to search files"
            }
            disabled={!hasWorkspace}
          />
        </label>
      </header>

      <section className="awb-files-panel__results">
        <div className="awb-files-panel__section-header">
          <h4>Search Results</h4>
          <span>{isSearching ? "Searching…" : searchResults.length}</span>
        </div>
        <div className="awb-files-panel__results-body">
          {query.trim().length === 0 ? null : (
            <div className="awb-files-panel__list">
              {searchResults.map((result) => (
                <button
                  key={result.path}
                  type="button"
                  className={`awb-files-panel__list-item ${
                    isSelected(selectedFile, result.path) ? "is-selected" : ""
                  }`}
                  onClick={() => onSelectFile(result)}
                >
                  <strong>{result.fileName}</strong>
                  <span>{result.relativePath}</span>
                </button>
              ))}
              {searchResults.length === 0 && !isSearching && (
                <div className="awb-files-panel__empty">
                  <p>No matching files in the active workspace.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <button
        type="button"
        className="awb-files-panel__resize-handle"
        onPointerDown={onResizeStart}
        aria-label="Resize search results and preview panels"
      >
        <span />
      </button>

      <section className="awb-files-panel__preview">
        <div className="awb-files-panel__section-header">
          <h4>Preview</h4>
          {selectedFile && (
            <span className="awb-files-panel__preview-file">{selectedFile.fileName}</span>
          )}
        </div>
        {selectedFile && (
          <div className="awb-files-panel__preview-actions">
            <button
              type="button"
              className="awb-ghost-button"
              onClick={() => onRunFileAction({ path: selectedFile.path, action: "open" })}
            >
              Open
            </button>
            <button
              type="button"
              className="awb-ghost-button"
              onClick={() => onRunFileAction({ path: selectedFile.path, action: "reveal" })}
            >
              Reveal
            </button>
          </div>
        )}
        {isLoadingPreview ? (
          <div className="awb-files-panel__empty">
            <p>Loading preview…</p>
          </div>
        ) : (
          renderPreviewBody(selectedFile, preview, onOpenImage)
        )}
      </section>
    </section>
  );
};
