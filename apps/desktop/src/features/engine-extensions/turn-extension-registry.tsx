import type { ReactElement } from "react";
import type { EngineSurfaceRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import { CodexHookActivitySlot } from "./codex/CodexHookActivitySlot.js";
import { CodexTurnChangesSlot } from "./codex/CodexTurnChangesSlot.js";

export type TurnExtensionRenderInput = {
  transport?: DesktopTransport;
  engineId?: string;
  engineSurface?: EngineSurfaceRpc;
  sessionId: string;
  turnId: string;
  refreshSignal?: number;
};

type TurnExtensionRenderer = (input: TurnExtensionRenderInput) => ReactElement | null;

const rendererByExtensionId: Record<string, TurnExtensionRenderer> = {
  "codex:hook-activity": (input) => (
    <CodexHookActivitySlot
      transport={input.transport}
      engineSurface={input.engineSurface}
      sessionId={input.sessionId}
      turnId={input.turnId}
      refreshSignal={input.refreshSignal}
    />
  ),
  "codex:changed-files": (input) => (
    <CodexTurnChangesSlot
      transport={input.transport}
      engineSurface={input.engineSurface}
      sessionId={input.sessionId}
      turnId={input.turnId}
    />
  )
};

export const renderTurnExtensions = (
  input: TurnExtensionRenderInput
): ReactElement | null => {
  if (!input.engineId || !input.engineSurface) {
    return null;
  }

  const rendered = input.engineSurface.extensions
    .filter((extension) => extension.available)
    .map((extension) =>
      rendererByExtensionId[`${input.engineId}:${extension.key}`]?.(input) ?? null
    )
    .filter((element): element is ReactElement => Boolean(element));

  if (rendered.length === 0) {
    return null;
  }

  return <>{rendered}</>;
};
