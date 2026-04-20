import type {
  EngineExtensionDescriptorRpc,
  EngineSharedCapabilityRpc,
  EngineSurfaceRpc
} from "@another-workbench/shared";

export type EngineSurfaceDefinition = {
  engineId: string;
  sharedCapabilities?: EngineSharedCapabilityRpc[];
  extensions?: EngineExtensionDescriptorRpc[];
};

type EngineCapabilitySurfaceServiceOptions = {
  surfaces?: EngineSurfaceDefinition[];
};

export class EngineCapabilitySurfaceService {
  private readonly surfacesByEngineId = new Map<string, EngineSurfaceRpc>();

  public constructor(options: EngineCapabilitySurfaceServiceOptions = {}) {
    for (const surface of options.surfaces ?? []) {
      this.register(surface);
    }
  }

  public register(surface: EngineSurfaceDefinition): void {
    this.surfacesByEngineId.set(surface.engineId, {
      engineId: surface.engineId,
      sharedCapabilities: [...(surface.sharedCapabilities ?? [])],
      extensions: [...(surface.extensions ?? [])]
    });
  }

  public get(engineId: string): EngineSurfaceRpc {
    const surface = this.surfacesByEngineId.get(engineId);
    if (!surface) {
      return {
        engineId,
        sharedCapabilities: [],
        extensions: []
      };
    }
    return {
      engineId: surface.engineId,
      sharedCapabilities: [...surface.sharedCapabilities],
      extensions: [...surface.extensions]
    };
  }
}
