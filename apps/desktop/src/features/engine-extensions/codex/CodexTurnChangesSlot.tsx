import { useEffect, useState, type ReactElement } from "react";
import type {
  CodexTurnChangesResultRpc,
  EngineSurfaceRpc
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { TurnExtensionSlot } from "../TurnExtensionSlot.js";
import { CodexTurnChangesExtension } from "./CodexTurnChangesExtension.js";

export const codexChangedFilesExtensionKey = "changed-files";

const hasEngineExtension = (
  surface: EngineSurfaceRpc | undefined,
  extensionKey: string
): boolean =>
  Boolean(
    surface?.extensions.some(
      (extension) => extension.key === extensionKey && extension.available
    )
  );

export type CodexTurnChangesSlotProps = {
  transport?: DesktopTransport;
  engineSurface?: EngineSurfaceRpc;
  sessionId: string;
  turnId: string;
};

export const CodexTurnChangesSlot = ({
  transport,
  engineSurface,
  sessionId,
  turnId
}: CodexTurnChangesSlotProps): ReactElement | null => {
  const [turnChanges, setTurnChanges] = useState<CodexTurnChangesResultRpc | undefined>();

  const isAvailable =
    Boolean(transport) && hasEngineExtension(engineSurface, codexChangedFilesExtensionKey);

  useEffect(() => {
    if (!transport || !isAvailable) {
      setTurnChanges(undefined);
      return;
    }
    let disposed = false;
    void transport.codex
      .getTurnChanges({
        sessionId,
        turnId
      })
      .then((result) => {
        if (!disposed) {
          setTurnChanges(result);
        }
      })
      .catch(() => {
        if (!disposed) {
          setTurnChanges(undefined);
        }
      });
    return () => {
      disposed = true;
    };
  }, [isAvailable, sessionId, transport, turnId]);

  if (!turnChanges || turnChanges.changedFiles.length === 0) {
    return null;
  }

  return (
    <TurnExtensionSlot extensionKey={codexChangedFilesExtensionKey}>
      <CodexTurnChangesExtension
        sessionId={sessionId}
        turnId={turnId}
        changedFiles={turnChanges.changedFiles}
        canUndo={turnChanges.canUndo}
        onUndoTurn={
          transport
            ? ({ sessionId: targetSessionId, turnId: targetTurnId }) =>
                transport.codex.undoTurnChanges({
                  sessionId: targetSessionId,
                  turnId: targetTurnId
                })
            : undefined
        }
      />
    </TurnExtensionSlot>
  );
};
