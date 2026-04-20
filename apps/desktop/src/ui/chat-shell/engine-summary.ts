import type { EngineDefinitionRpc, EngineSurfaceRpc } from "@another-workbench/shared";

export type EngineInspectorViewModel = {
  engineLabel: string;
  integrationLabel: string;
  capabilitiesLabel: string;
  extensionsLabel: string;
};

const summarizeExtensions = (surface: EngineSurfaceRpc | undefined): string => {
  if (!surface || surface.extensions.length === 0) {
    return "none";
  }
  return surface.extensions
    .map((extension) =>
      extension.available
        ? extension.displayName
        : `${extension.displayName} (unavailable)`
    )
    .join(", ");
};

export const buildEngineInspectorViewModel = (input: {
  selectedEngineId: string;
  engines: EngineDefinitionRpc[];
  surfacesByEngineId: Readonly<Record<string, EngineSurfaceRpc | undefined>>;
}): EngineInspectorViewModel => {
  if (!input.selectedEngineId) {
    return {
      engineLabel: "No engine selected",
      integrationLabel: "Integration: unknown",
      capabilitiesLabel: "Capabilities: loading…",
      extensionsLabel: "Extensions: loading…"
    };
  }

  const selectedEngine = input.engines.find(
    (engine) => engine.engineId === input.selectedEngineId
  );
  const surface = input.surfacesByEngineId[input.selectedEngineId];
  const capabilities =
    surface && surface.sharedCapabilities.length > 0
      ? surface.sharedCapabilities.join(", ")
      : surface
        ? "none"
        : "loading…";
  const extensions = surface ? summarizeExtensions(surface) : "loading…";

  return {
    engineLabel:
      selectedEngine?.displayName || input.selectedEngineId,
    integrationLabel: `Integration: ${selectedEngine?.integrationTier ?? "unknown"}`,
    capabilitiesLabel: `Capabilities: ${capabilities}`,
    extensionsLabel: `Extensions: ${extensions}`
  };
};
