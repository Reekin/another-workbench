import { useEffect, useRef, useState } from "react";
import type {
  ExtractedFileReference,
  FilePreviewRpc,
  WorkspaceFileSearchResultRpc
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ComposerStatusNotice } from "./composer-status.js";

type FileSelection = ExtractedFileReference | WorkspaceFileSearchResultRpc;

export const useFileBrowserController = (input: {
  transport?: DesktopTransport;
  activeWorkspaceId?: string;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
}): {
  query: string;
  setQuery: (value: string) => void;
  isSearching: boolean;
  searchResults: WorkspaceFileSearchResultRpc[];
  selectedFile?: FileSelection;
  preview?: FilePreviewRpc;
  isLoadingPreview: boolean;
  selectFile: (reference: FileSelection) => void;
  runFileAction: (input: {
    path: string;
    action: "open" | "reveal";
  }) => Promise<void>;
} => {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<WorkspaceFileSearchResultRpc[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileSelection | undefined>();
  const [preview, setPreview] = useState<FilePreviewRpc | undefined>();
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const searchRequestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);

  useEffect(() => {
    if (!input.transport || !input.activeWorkspaceId || !query.trim()) {
      setIsSearching(false);
      setSearchResults([]);
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    setIsSearching(true);
    const timeoutId = setTimeout(() => {
      void input.transport!.file
        .searchWorkspace({
          workspaceId: input.activeWorkspaceId!,
          query,
          limit: 30
        })
        .then((results) => {
          if (searchRequestIdRef.current !== requestId) {
            return;
          }
          setSearchResults(results);
        })
        .catch((error) => {
          if (searchRequestIdRef.current !== requestId) {
            return;
          }
          setSearchResults([]);
          input.onStatusNotice({
            message: `File search failed: ${(error as Error).message}`,
            persistent: true,
            source: "files"
          });
        })
        .finally(() => {
          if (searchRequestIdRef.current === requestId) {
            setIsSearching(false);
          }
        });
    }, 160);

    return () => clearTimeout(timeoutId);
  }, [input.activeWorkspaceId, input.onStatusNotice, input.transport, query]);

  const loadPreview = (reference: FileSelection): void => {
    if (!input.transport) {
      return;
    }
    const requestId = ++previewRequestIdRef.current;
    setSelectedFile(reference);
    setIsLoadingPreview(true);
    void input.transport.file
      .getPreview(reference.path)
      .then((nextPreview) => {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setPreview(nextPreview);
      })
      .catch((error) => {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setPreview(undefined);
        input.onStatusNotice({
          message: `File preview failed: ${(error as Error).message}`,
          persistent: true,
          source: "files"
        });
      })
      .finally(() => {
        if (previewRequestIdRef.current === requestId) {
          setIsLoadingPreview(false);
        }
      });
  };

  return {
    query,
    setQuery,
    isSearching,
    searchResults,
    selectedFile,
    preview,
    isLoadingPreview,
    selectFile: loadPreview,
    runFileAction: async (actionInput) => {
      if (!input.transport) {
        return;
      }
      const result = await input.transport.file.runAction(actionInput);
      if (result.ok) {
        input.onStatusNotice({
          message:
            actionInput.action === "open"
              ? `Opened ${result.displayPath}`
              : `Revealed ${result.displayPath}`,
          source: "files"
        });
        return;
      }

      if (typeof window !== "undefined") {
        window.open(result.fileUrl, "_blank", "noopener,noreferrer");
      }
      input.onStatusNotice({
        message:
          result.errorMessage ??
          `Falling back to the browser for ${result.displayPath}.`,
        source: "files"
      });
    }
  };
};
