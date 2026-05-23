import { useEffect, useState, type ReactElement } from "react";
import type {
  CodexHookActivityResultRpc,
  EngineSurfaceRpc
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import { TurnExtensionSlot } from "../TurnExtensionSlot.js";
import { CodexHookActivityExtension } from "./CodexHookActivityExtension.js";

export const codexHookActivityExtensionKey = "hook-activity";

const hasEngineExtension = (
  surface: EngineSurfaceRpc | undefined,
  extensionKey: string
): boolean =>
  Boolean(
    surface?.extensions.some(
      (extension) => extension.key === extensionKey && extension.available
    )
  );

export type CodexHookActivitySlotProps = {
  transport?: DesktopTransport;
  engineSurface?: EngineSurfaceRpc;
  sessionId: string;
  turnId: string;
  refreshSignal?: number;
};

export const CodexHookActivitySlot = ({
  transport,
  engineSurface,
  sessionId,
  turnId,
  refreshSignal = 0
}: CodexHookActivitySlotProps): ReactElement | null => {
  const [activity, setActivity] = useState<CodexHookActivityResultRpc | undefined>();

  const isAvailable =
    Boolean(transport) && hasEngineExtension(engineSurface, codexHookActivityExtensionKey);

  useEffect(() => {
    if (!transport || !isAvailable) {
      setActivity(undefined);
      return;
    }
    let disposed = false;
    void transport.codex
      .getHookActivity({
        sessionId,
        turnId
      })
      .then((result) => {
        if (!disposed) {
          setActivity(result);
        }
      })
      .catch(() => {
        if (!disposed) {
          setActivity(undefined);
        }
      });
    return () => {
      disposed = true;
    };
  }, [isAvailable, refreshSignal, sessionId, transport, turnId]);

  if (!activity || activity.runs.length === 0) {
    return null;
  }

  return (
    <TurnExtensionSlot extensionKey={codexHookActivityExtensionKey}>
      <CodexHookActivityExtension runs={activity.runs} />
    </TurnExtensionSlot>
  );
};
